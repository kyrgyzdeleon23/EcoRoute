from datetime import date, datetime, timedelta
from functools import wraps
import os
import re
import secrets
import uuid

from flask import Flask, jsonify, render_template, request, session

from data_algorithm import (
    distance_km,
    divide_and_conquer_shortest_path,
    exhaustive_shortest_path,
    filter_and_sort_requests,
    greedy_shortest_path,
    nearest_hub,
    priority_score,
    road_route,
)
from data_structures import AVLInventoryTree, EwastePriorityQueue, Graph
from supabase_store import (
    SupabaseConfigurationError,
    auth_request,
    database,
    is_configured,
)

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET_KEY") or secrets.token_urlsafe(32)
if not os.environ.get("FLASK_SECRET_KEY"):
    app.logger.warning("FLASK_SECRET_KEY is unset; sessions will expire when the app restarts.")
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("COOKIE_SECURE", "").lower() == "true",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=12),
)

pq = EwastePriorityQueue()
avl = AVLInventoryTree()
graph = Graph()

# Hub coordinates are stored as latitude/longitude pairs so they can be managed
# by an administrator and used for nearest-location lookup.
HUBS = {
    "Batangas City": (13.7565, 121.0583),
    "Bulacan Baliwag": (14.9547, 120.9003),
    "Cabuyao Laguna": (14.2726, 121.1262),
    "Lucban Quezon": (14.1136, 121.5550),
    "Bauan Batangas": (13.7917, 121.0085),
}
for first, second, distance in [
    ("Batangas City", "Bauan Batangas", 10.0),
    ("Batangas City", "Cabuyao Laguna", 63.0),
    ("Cabuyao Laguna", "Lucban Quezon", 61.0),
    ("Cabuyao Laguna", "Bulacan Baliwag", 100.0),
    ("Lucban Quezon", "Bulacan Baliwag", 130.0),
]:
    graph.add_edge(first, second, distance)

ITEMS = {
    "Batteries & Energy Storage": {"hazard": 5, "weight": 2.0, "items": ["Lithium-ion laptop/phone batteries", "Lead-acid UPS batteries", "NiMH rechargeable batteries", "Alkaline/Lithium button cells"]},
    "Displays & CRT Glass": {"hazard": 4, "weight": 12.0, "items": ["CRT computer monitors", "CRT televisions", "Flat-panel LCD/LED monitors", "Plasma screens"]},
    "Circuit Boards & Core IT": {"hazard": 4, "weight": 4.0, "items": ["Computer motherboards", "RAM & expansion cards", "CPU processors & GPUs", "Hard disk drives (HDDs/SSDs)"]},
    "Large Appliances & Chassis": {"hazard": 3, "weight": 20.0, "items": ["Desktop computer towers (chassis with components)", "Office printers & scanners", "Copiers & fax machines", "Server racks & power supplies"]},
    "Small Peripherals & Electronics": {"hazard": 2, "weight": 1.5, "items": ["Power adapters & laptop chargers", "Network routers, switches, & modems", "Webcams & digital microphones", "External hard drive enclosures"]},
    "Inert / Non-Hazardous Items": {"hazard": 1, "weight": 1.0, "items": ["Computer keyboards & optical mice", "Ethernet, USB, & audio patch cables", "Empty desktop computer towers / chassis", "Plastic printer trays & scanner covers"]},
}

REQUESTS = {}
AUDIT_LOG = []
PROFILE_PHONES = {}


def current_user():
    user_id = session.get("user_id")
    if not user_id:
        return None
    return {
        "id": user_id,
        "name": session["name"],
        "role": session["role"],
        "phone": session.get("phone") or PROFILE_PHONES.get(user_id, ""),
    }


def load_hubs():
    """Load persistent hubs and their edges when Supabase is configured."""
    if not is_configured():
        return
    hub_rows = database().table("hubs").select("name,latitude,longitude").execute().data
    edge_rows = database().table("hub_edges").select("hub_a,hub_b,distance").execute().data
    if not hub_rows:
        raise RuntimeError("No recycling hubs exist in Supabase; run supabase_schema.sql first.")
    HUBS.clear()
    HUBS.update({
        row["name"]: (row["latitude"], row["longitude"])
        for row in hub_rows
    })
    graph.adj.clear()
    for row in edge_rows:
        graph.add_edge(row["hub_a"], row["hub_b"], row["distance"])


def all_requests():
    """Read requests from Supabase, or the local development fallback."""
    if not is_configured():
        return list(REQUESTS.values())
    rows = database().table("requests").select("id,owner_id,data").execute().data
    return [
        {**row["data"], "user": row["owner_id"]}
        for row in rows
    ]


def get_request(item_id):
    if not is_configured():
        return REQUESTS.get(item_id)
    rows = (
        database().table("requests")
        .select("id,owner_id,data")
        .eq("id", item_id)
        .limit(1)
        .execute()
        .data
    )
    if not rows:
        return None
    return {**rows[0]["data"], "user": rows[0]["owner_id"]}


def save_request(request_item):
    if not is_configured():
        REQUESTS[request_item["id"]] = request_item
        return
    data = {key: value for key, value in request_item.items() if key != "user"}
    database().table("requests").upsert({
        "id": request_item["id"],
        "owner_id": request_item["user"],
        "data": data,
    }).execute()


def remove_request(item_id):
    if not is_configured():
        return REQUESTS.pop(item_id, None)
    existing = get_request(item_id)
    if existing is not None:
        database().table("requests").delete().eq("id", item_id).execute()
    return existing


def rebuild_inventory():
    avl.root = None
    for item in all_requests():
        if item["status"] == "Completed":
            avl.root = avl.insert(avl.root, item["category"], {
                "id": item["id"],
                "item": item["item"],
                "name": item["name"],
                "weight": item["weight"],
                "hazard": item["hazard"],
            })


def rebuild_priority_queue():
    pq.heap.clear()
    pq.counter = 0
    for item in all_requests():
        if item["status"] == "Pending":
            pq.add_request(
                item["id"], item["name"], item["category"], item["weight"],
                item["hazard"], item["urgency"], "Pending",
            )


def protected(role=None):
    def decorator(function):
        @wraps(function)
        def wrapped(*args, **kwargs):
            user = current_user()
            if not user:
                return jsonify({"error": "Login required"}), 401
            if role and user["role"] != role:
                return jsonify({"error": "Administrator access required"}), 403
            return function(*args, **kwargs)
        return wrapped
    return decorator


def add_audit(request_id, action, request_number):
    user = current_user()
    entry = {
        "audit_id": str(uuid.uuid4()),
        "request_id": request_id,
        "request_number": request_number,
        "action": action,
        "admin": user["name"],
        "admin_username": user["id"],
        "timestamp": datetime.now().isoformat(timespec="seconds"),
    }
    if is_configured():
        database().table("audit_log").insert({"data": entry}).execute()
    else:
        AUDIT_LOG.append(entry)


def request_reference(request_item):
    return request_item.get("request_number") or (
        f"ER-{re.sub(r'[^a-zA-Z0-9]', '', str(request_item['id']))[:6].upper()}"
    )


def request_route(request_item):
    load_hubs()
    destination = nearest_hub(request_item["latitude"], request_item["longitude"], HUBS)
    graph_route = greedy_shortest_path(graph, destination["name"], destination["name"])
    road = road_route(request_item["latitude"], request_item["longitude"], destination["name"], HUBS)
    return {
        "type": request_item["method"],
        "destination": destination["name"],
        "distance": road["distance"],
        "duration": road["duration"],
        "source": road["source"],
        "path": ["Your pinned location", *graph_route["path"]],
    }


def public_request(item):
    visible = dict(item)
    visible.pop("user", None)
    return visible


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/config")
def config():
    user = current_user()
    load_hubs()
    hubs = [{"name": name, "latitude": coordinates[0], "longitude": coordinates[1]} for name, coordinates in HUBS.items()]
    return jsonify({"categories": ITEMS, "hubs": hubs, "user": user and {
        "name": user["name"], "role": user["role"], "phone": user["phone"],
    }})


@app.route("/api/route-preview")
@protected("user")
def route_preview():
    try:
        latitude = float(request.args["latitude"])
        longitude = float(request.args["longitude"])
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "A valid pinned location is required"}), 400
    load_hubs()
    destination = nearest_hub(latitude, longitude, HUBS)
    road = road_route(latitude, longitude, destination["name"], HUBS)
    return jsonify({"destination": destination["name"], **road})


@app.route("/api/admin/hub-route")
@protected("admin")
def compare_hub_routes():
    load_hubs()
    start = request.args.get("start")
    end = request.args.get("end")
    if start not in HUBS or end not in HUBS:
        return jsonify({"error": "Choose two valid hubs"}), 400
    try:
        return jsonify({
            "greedy": greedy_shortest_path(graph, start, end),
            "exhaustive": exhaustive_shortest_path(graph, start, end),
            "divide_and_conquer": divide_and_conquer_shortest_path(graph, start, end),
        })
    except ValueError as error:
        return jsonify({"error": str(error)}), 400


@app.route("/api/admin/hubs", methods=["POST"])
@protected("admin")
def add_hub():
    load_hubs()
    data = request.get_json() or {}
    name = data.get("name", "").strip()
    try:
        latitude = float(data["latitude"])
        longitude = float(data["longitude"])
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "A valid latitude and longitude are required"}), 400
    if not name or name in HUBS:
        return jsonify({"error": "A unique hub name is required"}), 400
    if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
        return jsonify({"error": "The coordinates are outside valid GPS bounds"}), 400

    nearest_name = nearest_hub(latitude, longitude, HUBS)["name"]
    if is_configured():
        database().table("hubs").insert({
            "name": name,
            "latitude": latitude,
            "longitude": longitude,
        }).execute()
        hub_a, hub_b = sorted((nearest_name, name))
        database().table("hub_edges").insert({
            "hub_a": hub_a,
            "hub_b": hub_b,
            "distance": distance_km(latitude, longitude, HUBS[nearest_name][0], HUBS[nearest_name][1]),
        }).execute()
    HUBS[name] = (latitude, longitude)
    graph.add_edge(nearest_name, name, distance_km(latitude, longitude, HUBS[nearest_name][0], HUBS[nearest_name][1]))
    return jsonify({"status": "success", "hub": {"name": name, "latitude": latitude, "longitude": longitude}})


@app.route("/api/admin/hubs/<hub_name>", methods=["DELETE"])
@protected("admin")
def delete_hub(hub_name):
    load_hubs()
    if hub_name not in HUBS:
        return jsonify({"error": "Hub not found"}), 404
    if len(HUBS) <= 1:
        return jsonify({"error": "At least one hub must remain"}), 400
    if is_configured():
        database().table("hubs").delete().eq("name", hub_name).execute()
        load_hubs()
    else:
        HUBS.pop(hub_name)
        graph.adj.pop(hub_name, None)
        for neighbors in graph.adj.values():
            neighbors[:] = [(name, weight) for name, weight in neighbors if name != hub_name]
    return jsonify({"status": "success"})


@app.route("/api/signup", methods=["POST"])
def signup():
    data = request.get_json() or {}
    if not isinstance(data, dict):
        return jsonify({"error": "A valid signup form is required"}), 400
    email = data.get("email")
    name = data.get("name")
    password = data.get("password", "")
    if (
        not isinstance(email, str)
        or not isinstance(name, str)
        or not isinstance(password, str)
        or not email.strip()
        or not name.strip()
        or len(password) < 6
    ):
        return jsonify({"error": "Name, valid email, and a password of at least 6 characters are required"}), 400
    email = email.strip().lower()
    name = name.strip()
    try:
        status, result = auth_request("signup", {
            "email": email,
            "password": password,
            "data": {"name": name},
        })
    except SupabaseConfigurationError as error:
        return jsonify({"error": str(error)}), 503
    if status >= 400:
        return jsonify({"error": result["error"]}), status

    auth_user = result.get("user") or result
    user_id = auth_user.get("id")
    if not user_id:
        return jsonify({"error": "Supabase signup did not return a user"}), 502
    if is_configured():
        database().table("profiles").upsert({
            "id": user_id,
            "name": name,
            "role": "user",
            "phone": "",
        }).execute()
    if not result.get("access_token"):
        return jsonify({
            "status": "confirmation_required",
            "message": "Check your email to confirm your account, then log in.",
        })
    session.clear()
    session.permanent = True
    session.update({"user_id": user_id, "name": name, "role": "user", "phone": ""})
    return jsonify({"status": "success", "role": "user", "name": name})


@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json() or {}
    if not isinstance(data, dict):
        return jsonify({"error": "A valid login form is required"}), 400
    email = data.get("email")
    password = data.get("password", "")
    if not isinstance(email, str) or not isinstance(password, str) or not email.strip() or not password:
        return jsonify({"error": "Email and password are required"}), 400
    email = email.strip().lower()
    try:
        status, result = auth_request("token?grant_type=password", {
            "email": email,
            "password": password,
        })
    except SupabaseConfigurationError as error:
        return jsonify({"error": str(error)}), 503
    if status >= 400:
        return jsonify({"error": result["error"]}), status
    auth_user = result.get("user", {})
    user_id = auth_user.get("id")
    if not user_id:
        return jsonify({"error": "Supabase login did not return a user"}), 502
    rows = (
        database().table("profiles")
        .select("name,role,phone")
        .eq("id", user_id)
        .limit(1)
        .execute()
        .data
    )
    if not rows:
        return jsonify({"error": "Your account profile is missing. Contact an administrator."}), 403
    profile = rows[0]
    session.clear()
    session.permanent = True
    session.update({
        "user_id": user_id,
        "name": profile["name"],
        "role": profile["role"],
        "phone": profile.get("phone") or "",
    })
    return jsonify({"status": "success", "role": profile["role"], "name": profile["name"]})


@app.route("/api/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"status": "success"})


@app.route("/api/e-waste", methods=["POST"])
@protected("user")
def add_ewaste():
    data = request.get_json() or {}
    category = data.get("category")
    details = ITEMS.get(category)
    phone = data.get("phone")
    if not isinstance(phone, str):
        return jsonify({"error": "A contact phone number is required"}), 400
    phone = phone.strip()
    phone_digits = re.sub(r"[^0-9]", "", phone)
    if not re.fullmatch(r"\+?[0-9\s().-]{7,20}", phone) or not 7 <= len(phone_digits) <= 15:
        return jsonify({"error": "Enter a valid phone number with 7 to 15 digits"}), 400
    try:
        latitude = float(data["latitude"])
        longitude = float(data["longitude"])
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "A valid pinned location is required"}), 400
    if not details or data.get("item") not in details["items"] or data.get("method") not in {"pickup", "dropoff"}:
        return jsonify({"error": "Choose an item and pickup or drop-off"}), 400
    if data.get("save_phone_default") is True:
        if is_configured():
            database().table("profiles").update({"phone": phone}).eq("id", session["user_id"]).execute()
        else:
            PROFILE_PHONES[session["user_id"]] = phone
        session["phone"] = phone
    item_id = str(uuid.uuid4())
    method = data["method"]
    method_count = sum(
        1 for existing in all_requests()
        if existing.get("method") == method
    )
    reference_prefix = "PU" if method == "pickup" else "DO"
    request_number = f"{reference_prefix}-{method_count + 1:04d}"
    request_item = {
        "id": item_id, "user": session["user_id"], "name": current_user()["name"],
        "category": category, "item": data["item"], "method": method,
        "request_number": request_number,
        "phone": phone,
        "latitude": latitude, "longitude": longitude, "weight": details["weight"],
        "hazard": details["hazard"], "urgency": details["hazard"], "status": "Pending",
        "priority_score": 0, "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    request_item["priority_score"] = round(priority_score(request_item), 2)
    save_request(request_item)
    pq.add_request(item_id, request_item["name"], category, request_item["weight"], request_item["hazard"], request_item["urgency"], "Pending")
    return jsonify({"status": "success", "id": item_id})


@app.route("/api/my-requests")
@protected("user")
def my_requests():
    return jsonify([
        public_request(item) for item in all_requests()
        if item["user"] == session["user_id"]
    ])


@app.route("/api/admin/requests")
@protected("admin")
def admin_requests():
    load_hubs()
    search = request.args.get("search", "")
    sort_by = request.args.get("sort", "risk")
    ordered = filter_and_sort_requests(all_requests(), search, sort_by, HUBS)
    status = request.args.get("status", "")
    method = request.args.get("method", "")
    hazard = request.args.get("hazard", "")
    from_date = request.args.get("from_date", "")
    to_date = request.args.get("to_date", "")
    if status and status not in {"Pending", "Approved", "Rejected", "Completed"}:
        return jsonify({"error": "Choose a valid request status"}), 400
    if method and method not in {"pickup", "dropoff"}:
        return jsonify({"error": "Choose a valid collection method"}), 400
    if hazard and hazard not in {"1", "2", "3", "4", "5"}:
        return jsonify({"error": "Choose a valid hazard level"}), 400
    try:
        start = date.fromisoformat(from_date) if from_date else None
        end = date.fromisoformat(to_date) if to_date else None
    except ValueError:
        return jsonify({"error": "Enter valid date filters"}), 400
    if start and end and start > end:
        return jsonify({"error": "Start date must be on or before end date"}), 400
    ordered = [
        item for item in ordered
        if (not status or item["status"] == status)
        and (not method or item["method"] == method)
        and (not hazard or item["hazard"] == int(hazard))
        and (not start or date.fromisoformat(item["created_at"][:10]) >= start)
        and (not end or date.fromisoformat(item["created_at"][:10]) <= end)
    ]
    return jsonify([public_request(item) for item in ordered])


@app.route("/api/admin/requests/<item_id>", methods=["POST"])
@protected("admin")
def update_request(item_id):
    request_item = get_request(item_id)
    if not request_item:
        return jsonify({"error": "Request not found"}), 404
    data = request.get_json() or {}
    action = data.get("action")
    if action not in {"approve", "reject", "complete"}:
        return jsonify({"error": "Invalid action"}), 400
    if action == "reject":
        reason = data.get("reason")
        if not isinstance(reason, str) or not reason.strip():
            return jsonify({"error": "A rejection reason is required"}), 400
        reason = reason.strip()
        if len(reason) > 500:
            return jsonify({"error": "The rejection reason must be 500 characters or fewer"}), 400
        request_item["rejection_reason"] = reason
    if action == "complete":
        if request_item["status"] != "Approved":
            return jsonify({"error": "Only approved requests can be completed"}), 400
        request_item["status"] = "Completed"
        request_item["completed_at"] = datetime.now().isoformat(timespec="seconds")
        save_request(request_item)
        add_audit(item_id, "completed", request_reference(request_item))
        pq.remove_request(request_item["id"])
        avl.root = avl.insert(avl.root, request_item["category"], {
            "id": request_item["id"],
            "item": request_item["item"],
            "name": request_item["name"],
            "weight": request_item["weight"],
            "hazard": request_item["hazard"],
        })
        return jsonify({"status": "success", "request": public_request(request_item)})

    request_item["status"] = "Approved" if action == "approve" else "Rejected"
    timestamp = datetime.now().isoformat(timespec="seconds")
    if action == "approve":
        request_item["approved_at"] = timestamp
    else:
        request_item["rejected_at"] = timestamp
    if request_item["status"] == "Rejected":
        pq.remove_request(request_item["id"])
    if request_item["status"] == "Approved":
        load_hubs()
        request_item["route"] = request_route(request_item)
        if request_item["method"] == "pickup":
            request_item["queue_number"] = sum(
                1 for item in all_requests()
                if item["id"] != item_id and item["method"] == "pickup" and item["status"] == "Approved"
            ) + 1
    save_request(request_item)
    add_audit(item_id, "approved" if action == "approve" else "rejected", request_reference(request_item))
    return jsonify({"status": "success", "request": public_request(request_item)})


@app.route("/api/admin/requests/<item_id>", methods=["DELETE"])
@protected("admin")
def delete_request(item_id):
    request_item = remove_request(item_id)
    if not request_item:
        return jsonify({"error": "Request not found"}), 404
    add_audit(item_id, "deleted", request_reference(request_item))
    pq.remove_request(item_id)
    avl.root = avl.delete(avl.root, request_item["category"], item_id)
    return jsonify({"status": "success", "id": item_id})


@app.route("/api/inventory")
@protected("admin")
def get_inventory():
    rebuild_inventory()
    return jsonify(avl.in_order_traversal(avl.root))


@app.route("/api/admin/inventory-summary")
@protected("admin")
def inventory_summary():
    rebuild_inventory()
    categories = avl.in_order_traversal(avl.root)
    return jsonify({
        "categories": [{
            "category": category["category"],
            "item_count": len(category["items"]),
            "total_weight": round(sum(item["weight"] for item in category["items"]), 2),
            "hazard_total": sum(item["hazard"] for item in category["items"]),
        } for category in categories],
        "total_items": sum(len(category["items"]) for category in categories),
        "total_weight": round(sum(item["weight"] for category in categories for item in category["items"]), 2),
    })


@app.route("/api/admin/audit")
@protected("admin")
def audit_history():
    if is_configured():
        rows = database().table("audit_log").select("id,data").order("created_at", desc=True).execute().data
        entries = [{**row["data"], "audit_id": str(row["id"])} for row in rows]
    else:
        entries = list(reversed(AUDIT_LOG))
    request_numbers = {
        item["id"]: request_reference(item)
        for item in all_requests()
    }
    return jsonify([
        {
            **entry,
            "request_number": entry.get("request_number") or request_numbers.get(entry["request_id"]),
        }
        for entry in entries
    ])


@app.route("/api/admin/audit/<audit_id>", methods=["DELETE"])
@protected("admin")
def delete_audit_entry(audit_id):
    if is_configured():
        if not audit_id.isdigit() or int(audit_id) < 1:
            return jsonify({"error": "Audit entry not found"}), 404
        audit_id = int(audit_id)
        existing = database().table("audit_log").select("id").eq("id", audit_id).limit(1).execute().data
        if not existing:
            return jsonify({"error": "Audit entry not found"}), 404
        database().table("audit_log").delete().eq("id", audit_id).execute()
    else:
        entry_index = next(
            (index for index, entry in enumerate(AUDIT_LOG) if entry.get("audit_id") == audit_id),
            None,
        )
        if entry_index is None:
            return jsonify({"error": "Audit entry not found"}), 404
        del AUDIT_LOG[entry_index]
    return jsonify({"status": "success", "audit_id": str(audit_id)})


@app.route("/api/inventory/<path:category>")
@protected("admin")
def get_inventory_category(category):
    rebuild_inventory()
    result = avl.search(avl.root, category)
    if result is None:
        return jsonify({"error": "Category not found"}), 404
    return jsonify(result)


@app.route("/api/priority-queue/peek")
@protected("admin")
def peek_priority_queue():
    rebuild_priority_queue()
    return jsonify(pq.peek() or {})


if __name__ == "__main__":
    app.run(debug=os.environ.get("FLASK_DEBUG", "").lower() == "true", port=5000)
