const $ = (selector) => document.querySelector(selector);
let config;
let liveGpsWatch;
let adminSearchTimer;
let routePreviewToken = 0;

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

function showApp(user) {
  $("#authView").style.display = "none";
  const app = user.role === "admin" ? $("#adminApp") : $("#userApp");
  app.style.display = "block";
  $(user.role === "admin" ? "#adminName" : "#userName").textContent = user.name;
  if (user.role === "admin") {
    loadAdmin();
    EcoRouteMap.initAdminMap(config.hubs, setHubCoordinates);
    renderHubList();
    loadInventorySummary();
    loadAuditHistory();
  } else {
    EcoRouteMap.initUserMap(config.hubs, setUserCoordinates);
    loadUser();
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  }[char]));
}

function renderRisk() {
  $("#riskGuide").innerHTML = Object.entries(config.categories).map(([name, data]) =>
    `<div style="display:flex;justify-content:space-between;border-bottom:1px solid var(--line);padding:11px 0"><span>${name}</span><strong>Level ${data.hazard}</strong></div>`
  ).join("");
}

function renderItems() {
  const data = config.categories[$("#category").value];
  $("#item").innerHTML = data.items.map((item) => `<option>${item}</option>`).join("");
}

function routeSummary(route) {
  if (!route) return "";
  const label = route.type === "pickup" ? "Pickup point" : "Shortest drop-off route";
  return `<div class="hint"><strong>${label}:</strong> ${escapeHtml(route.destination)} · ${route.distance} km</div><div class="hint">${route.path.map(escapeHtml).join(" → ")}</div>`;
}

function approvalGuidance(item) {
  if (item.status === "Pending") return '<div class="hint">Awaiting admin approval. Do not drop off this item yet.</div>';
  if (item.status === "Rejected") return '<div class="hint">This request was not approved. Please submit a new request if needed.</div>';
  if (item.status === "Completed") return `<div class="hint"><strong>Completed:</strong> ${item.method === "dropoff" ? "Drop-off confirmed by admin." : "Pickup confirmed by admin."}</div>`;
  if (item.method === "dropoff") return '<div class="hint"><strong>Approved:</strong> You may now take this item to the listed drop-off point.</div>';
  return '<div class="hint"><strong>Approved:</strong> Keep the item ready for collection.</div>';
}

function completionSummary(item) {
  return item.completed_at ? `<div class="hint">Confirmed ${escapeHtml(item.completed_at.replace("T", " "))}</div>` : "";
}

function lifecycleSummary(item) {
  const events = [["Submitted", item.created_at], ["Approved", item.approved_at], ["Rejected", item.rejected_at], ["Completed", item.completed_at]];
  return events.filter(([, timestamp]) => timestamp).map(([label, timestamp]) => `<div class="hint">${label}: ${escapeHtml(timestamp.replace("T", " "))}</div>`).join("");
}

function adminActions(item, admin) {
  if (!admin) return "";
  let actions = "";
  if (item.status === "Pending") actions += `<button class="action approve" onclick="updateRequest('${item.id}','approve')">Approve</button><button class="action reject" onclick="updateRequest('${item.id}','reject')">Reject</button>`;
  if (item.status === "Approved") actions += `<button class="action approve" onclick="updateRequest('${item.id}','complete')">Confirm ${item.method === "dropoff" ? "drop-off" : "pickup"}</button>`;
  actions += `<button class="action reject" onclick="deleteRequest('${item.id}')">Delete</button>`;
  return `<td>${actions}</td>`;
}

function requestTable(items, admin = false) {
  if (!items.length) return '<p class="empty">No requests yet.</p>';
  return `<table><thead><tr><th>Request</th><th>Resident</th><th>Item</th><th>Method</th><th>Risk</th><th>Score</th><th>Status</th>${admin ? "<th>Action</th>" : ""}</tr></thead><tbody>${items.map((item) => `<tr><td>#${item.id}</td><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.item)}</td><td>${item.method}</td><td><strong>${item.hazard}/5</strong></td><td>${item.priority_score}</td><td><span class="status ${item.status}">${item.status}</span>${approvalGuidance(item)}${lifecycleSummary(item)}${routeSummary(item.route)}${item.queue_number ? `<div class="hint">Pickup queue #${item.queue_number}</div>` : ""}</td>${adminActions(item, admin)}</tr>`).join("")}</tbody></table>`;
}

async function loadUser() {
  const requests = await api("/api/my-requests");
  $("#userRequests").innerHTML = requestTable(requests.filter((item) => !["Completed", "Rejected"].includes(item.status)));
  $("#userHistory").innerHTML = requestTable(requests.filter((item) => ["Completed", "Rejected"].includes(item.status)));
}

async function loadAdmin() {
  const params = new URLSearchParams({ search: $("#adminSearch").value, sort: $("#adminSort").value });
  const requests = await api(`/api/admin/requests?${params}`);
  $("#adminRequests").innerHTML = requestTable(requests.filter((item) => !["Completed", "Rejected"].includes(item.status)), true);
  $("#adminHistory").innerHTML = requestTable(requests.filter((item) => ["Completed", "Rejected"].includes(item.status)), true);
}

async function loadInventorySummary() {
  const summary = await api("/api/admin/inventory-summary");
  $("#inventorySummary").innerHTML = `<p class="hint">${summary.total_items} completed items · ${summary.total_weight} kg total</p>${summary.categories.length ? `<table><thead><tr><th>Category</th><th>Items</th><th>Total weight</th><th>Hazard total</th></tr></thead><tbody>${summary.categories.map((category) => `<tr><td>${escapeHtml(category.category)}</td><td>${category.item_count}</td><td>${category.total_weight} kg</td><td>${category.hazard_total}</td></tr>`).join("")}</tbody></table>` : '<p class="empty">No completed inventory yet.</p>'}`;
}

async function loadAuditHistory() {
  const entries = await api("/api/admin/audit");
  $("#auditHistory").innerHTML = entries.length ? `<table><thead><tr><th>Request</th><th>Action</th><th>Admin</th><th>Timestamp</th></tr></thead><tbody>${entries.map((entry) => `<tr><td>#${entry.request_id}</td><td>${escapeHtml(entry.action)}</td><td>${escapeHtml(entry.admin)}</td><td>${escapeHtml(entry.timestamp.replace("T", " "))}</td></tr>`).join("")}</tbody></table>` : '<p class="empty">No admin actions yet.</p>';
}

setInterval(() => {
  if ($("#userApp").style.display === "block") loadUser();
}, 5000);

function setHubCoordinates(latitude, longitude) {
  $("#hubLatitude").value = latitude.toFixed(6);
  $("#hubLongitude").value = longitude.toFixed(6);
}

function setUserCoordinates(latitude, longitude) {
  $("#latitude").value = latitude.toFixed(6);
  $("#longitude").value = longitude.toFixed(6);
  $("#locationStatus").textContent = `Pinned location: ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
  updateLocationPreview(latitude, longitude);
}

async function updateLocationPreview(latitude, longitude) {
  const token = ++routePreviewToken;
  $("#locationDetails").textContent = "Calculating nearest hub and road route...";
  try {
    const preview = await api(`/api/route-preview?latitude=${latitude}&longitude=${longitude}`);
    if (token !== routePreviewToken) return;
    const duration = preview.duration == null ? "duration unavailable" : `${preview.duration} min`;
    $("#locationDetails").textContent = `Nearest hub: ${preview.destination} · ${preview.distance} km · ${duration} · ${preview.source}`;
  } catch (error) {
    if (token === routePreviewToken) $("#locationDetails").textContent = error.message;
  }
}

function renderHubList() {
  $("#hubList").innerHTML = config.hubs.map((hub) => `<div class="hub-row"><span>${escapeHtml(hub.name)}<small>${hub.latitude.toFixed(5)}, ${hub.longitude.toFixed(5)}</small></span><button class="action reject" onclick="removeHub('${escapeHtml(hub.name)}')">Remove</button></div>`).join("");
  const options = config.hubs.map((hub) => `<option value="${escapeHtml(hub.name)}">${escapeHtml(hub.name)}</option>`).join("");
  const previousStart = $("#routeStart").value;
  const previousEnd = $("#routeEnd").value;
  $("#routeStart").innerHTML = options;
  $("#routeEnd").innerHTML = options;
  if (config.hubs.some((hub) => hub.name === previousStart)) $("#routeStart").value = previousStart;
  if (config.hubs.some((hub) => hub.name === previousEnd)) $("#routeEnd").value = previousEnd;
}

async function authenticate(url, payload) {
  try {
    const data = await api(url, { method: "POST", body: JSON.stringify(payload) });
    if (data.status === "confirmation_required") {
      $("#authError").textContent = data.message;
      return;
    }
    showApp({ name: data.name || payload.name, role: data.role || "user" });
  } catch (error) {
    $("#authError").textContent = error.message;
  }
}

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((item) => item.classList.remove("active"));
  tab.classList.add("active");
  $("#loginForm").classList.toggle("hidden", tab.dataset.mode !== "login");
  $("#signupForm").classList.toggle("hidden", tab.dataset.mode !== "signup");
  $("#authError").textContent = "";
}));

$("#loginForm").addEventListener("submit", (event) => {
  event.preventDefault();
  authenticate("/api/login", { email: $("#loginEmail").value, password: $("#loginPassword").value });
});

$("#signupForm").addEventListener("submit", (event) => {
  event.preventDefault();
  authenticate("/api/signup", { name: $("#signupName").value, email: $("#signupEmail").value, password: $("#signupPassword").value });
});

document.querySelectorAll(".logout").forEach((button) => button.addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  window.location.reload();
}));

$("#category").addEventListener("change", renderItems);
$("#locate").addEventListener("click", () => {
  if (!navigator.geolocation) {
    $("#locationStatus").textContent = "This browser does not support GPS.";
    return;
  }
  if (liveGpsWatch) navigator.geolocation.clearWatch(liveGpsWatch);
  $("#locationStatus").textContent = "Tracking your live location...";
  liveGpsWatch = navigator.geolocation.watchPosition((position) => {
    setUserCoordinates(position.coords.latitude, position.coords.longitude);
    $("#locationStatus").textContent = `Live location: ${position.coords.latitude.toFixed(4)}, ${position.coords.longitude.toFixed(4)}`;
  }, () => { $("#locationStatus").textContent = "Location permission was not granted."; }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 });
});

$("#centerLocation").addEventListener("click", () => {
  if (EcoRouteMap.centerUserMap()) return;
  navigator.geolocation.getCurrentPosition((position) => setUserCoordinates(position.coords.latitude, position.coords.longitude), () => {
    $("#locationStatus").textContent = "Location permission was not granted.";
  }, { enableHighAccuracy: true });
});

$("#requestForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!$("#latitude").value || !$("#longitude").value) {
    $("#requestError").textContent = "Click the map or use GPS to pin your location before submitting.";
    return;
  }
  const submitButton = $("#requestSubmit");
  submitButton.disabled = true;
  submitButton.textContent = "Saving request...";
  $("#requestConfirmation").textContent = "";
  try {
    await api("/api/e-waste", { method: "POST", body: JSON.stringify({ category: $("#category").value, item: $("#item").value, method: $("#method").value, latitude: $("#latitude").value, longitude: $("#longitude").value }) });
    event.target.reset();
    $("#locationStatus").textContent = "Location is required before submitting.";
    $("#latitude").value = "";
    $("#longitude").value = "";
    $("#requestError").textContent = "";
    $("#requestConfirmation").textContent = "Request submitted. It is now waiting for admin approval.";
    EcoRouteMap.clearUserPin();
    loadUser();
  } catch (error) {
    $("#requestError").textContent = error.message;
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Submit request";
  }
});

$("#refreshUser").addEventListener("click", loadUser);
$("#refreshAdmin").addEventListener("click", loadAdmin);
$("#adminSearch").addEventListener("input", () => {
  clearTimeout(adminSearchTimer);
  adminSearchTimer = setTimeout(loadAdmin, 250);
});
$("#adminSort").addEventListener("change", loadAdmin);
$("#clearAdminSearch").addEventListener("click", () => { $("#adminSearch").value = ""; $("#adminSort").value = "risk"; loadAdmin(); });
$("#adminLocate").addEventListener("click", () => navigator.geolocation.getCurrentPosition((position) => setHubCoordinates(position.coords.latitude, position.coords.longitude), () => { $("#hubError").textContent = "Location permission was not granted."; }, { enableHighAccuracy: true }));
$("#routePlanForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = $("#routePlanResult");
  result.textContent = "Comparing routes...";
  try {
    const params = new URLSearchParams({ start: $("#routeStart").value, end: $("#routeEnd").value });
    const comparison = await api(`/api/admin/hub-route?${params}`);
    const formatRoute = (label, route) => route.path.length
      ? `<div><strong>${label}:</strong> ${route.distance} km · ${route.path.map(escapeHtml).join(" → ")}</div>`
      : `<div><strong>${label}:</strong> No route found</div>`;
    result.innerHTML = `${formatRoute("Greedy (Dijkstra)", comparison.greedy)}${formatRoute("Exhaustive Search", comparison.exhaustive)}`;
  } catch (error) {
    result.textContent = error.message;
  }
});
$("#hubForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/admin/hubs", { method: "POST", body: JSON.stringify({ name: $("#hubName").value, latitude: $("#hubLatitude").value, longitude: $("#hubLongitude").value }) });
    config = await api("/api/config");
    event.target.reset();
    $("#hubError").textContent = "";
    EcoRouteMap.initAdminMap(config.hubs, setHubCoordinates);
    renderHubList();
  } catch (error) {
    $("#hubError").textContent = error.message;
  }
});

window.updateRequest = async (id, action) => {
  await api(`/api/admin/requests/${id}`, { method: "POST", body: JSON.stringify({ action }) });
  loadAdmin();
  loadInventorySummary();
  loadAuditHistory();
};

window.deleteRequest = async (id) => {
  if (!window.confirm("Delete this request from the system and history?")) return;
  await api(`/api/admin/requests/${id}`, { method: "DELETE" });
  loadAdmin();
  loadInventorySummary();
  loadAuditHistory();
};

window.removeHub = async (name) => {
  try {
    await api(`/api/admin/hubs/${encodeURIComponent(name)}`, { method: "DELETE" });
    config = await api("/api/config");
    EcoRouteMap.initAdminMap(config.hubs, setHubCoordinates);
    renderHubList();
  } catch (error) {
    $("#hubError").textContent = error.message;
  }
};

(async () => {
  try {
    config = await api("/api/config");
    if (config.user) showApp(config.user);
    else $("#authView").style.display = "grid";
    $("#category").innerHTML = Object.keys(config.categories).map((category) => `<option>${category}</option>`).join("");
    renderItems();
    renderRisk();
  } catch (error) {
    $("#authError").textContent = error.message;
  }
})();
