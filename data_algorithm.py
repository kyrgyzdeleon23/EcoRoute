"""Routing, request-scoring, and request-ordering algorithms for EcoRoute."""

import heapq
import json
import math
from functools import lru_cache
from urllib.request import urlopen

# First algorithm: Greedy Dijkstra shortest-path search.
def greedy_shortest_path(graph, start, end):
    """Find a shortest route by repeatedly visiting the nearest known hub."""
    pq = [(0, start, [start])]
    visited = set()

    while pq:
        cost, current, path = heapq.heappop(pq)
        if current in visited:
            continue
        visited.add(current)

        if current == end:
            return {"distance": cost, "path": path}

        for neighbor, weight in graph.adj.get(current, []):
            if neighbor not in visited:
                heapq.heappush(pq, (cost + weight, neighbor, path + [neighbor]))

    return {"distance": float("inf"), "path": []}


# Second algorithm: Exhaustive simple-path search.
def exhaustive_shortest_path(graph, start, end):
    """Check all simple routes for a shortest path in networks of up to 10 hubs."""
    if len(graph.adj) > 10:
        raise ValueError("Exhaustive route search supports networks with at most 10 hubs")
    if start not in graph.adj or end not in graph.adj:
        return {"distance": float("inf"), "path": []}

    shortest = {"distance": float("inf"), "path": []}

    def visit(current, visited, path, distance):
        if current == end:
            if distance < shortest["distance"]:
                shortest.update(distance=distance, path=path.copy())
            return

        for neighbor, weight in graph.adj[current]:
            if neighbor not in visited and distance + weight < shortest["distance"]:
                visited.add(neighbor)
                path.append(neighbor)
                visit(neighbor, visited, path, distance + weight)
                path.pop()
                visited.remove(neighbor)

    visit(start, {start}, [start], 0)
    return shortest


# Third algorithm: Divide-and-conquer shortest-path search.
def divide_and_conquer_shortest_path(graph, start, end):
    """Find a shortest route by recursively splitting the edge-count limit.

    The recursion combines shortest subroutes whose maximum edge counts sum
    to the current limit. A shortest simple route has at most |V| - 1 edges.
    """
    vertices = tuple(graph.adj)
    if start not in graph.adj or end not in graph.adj:
        return {"distance": float("inf"), "path": []}

    @lru_cache(maxsize=None)
    def shortest_with_limit(source, destination, edge_limit):
        if edge_limit == 0:
            if source == destination:
                return 0, (source,)
            return float("inf"), ()
        if edge_limit == 1:
            if source == destination:
                return 0, (source,)
            direct_routes = [
                (weight, (source, destination))
                for neighbor, weight in graph.adj[source]
                if neighbor == destination
            ]
            return min(direct_routes, default=(float("inf"), ()))

        left_limit = edge_limit // 2
        right_limit = edge_limit - left_limit
        best_distance = float("inf")
        best_path = ()

        for midpoint in vertices:
            left_distance, left_path = shortest_with_limit(
                source, midpoint, left_limit
            )
            if not left_path:
                continue
            right_distance, right_path = shortest_with_limit(
                midpoint, destination, right_limit
            )
            candidate_distance = left_distance + right_distance
            if right_path and candidate_distance < best_distance:
                best_distance = candidate_distance
                best_path = left_path + right_path[1:]

        return best_distance, best_path

    distance, path = shortest_with_limit(start, end, max(len(vertices) - 1, 0))
    return {"distance": distance, "path": list(path)}

# Fourth algorithm: Priority score for a request based on urgency, hazard, and weight.
def priority_score(request_item):
    """Score a request from its urgency, hazard, and weight."""
    return request_item["urgency"] * 3 + request_item["hazard"] * 2 + request_item["weight"] / 10

# Fifth algorithm: Geographic distance estimation.
def distance_km(latitude, longitude, hub_latitude, hub_longitude):
    """Estimate geographic distance between two latitude/longitude points."""
    latitude_scale = 111.0
    longitude_scale = 111.0 * math.cos(math.radians(latitude))
    latitude_distance = (latitude - hub_latitude) * latitude_scale
    longitude_distance = (longitude - hub_longitude) * longitude_scale
    return math.sqrt(latitude_distance ** 2 + longitude_distance ** 2)


def nearest_hub(latitude, longitude, hubs):
    """Find the nearest hub by recursively dividing the candidates in half."""
    def closest_in_range(candidates):
        if len(candidates) == 1:
            return candidates[0]
        midpoint = len(candidates) // 2
        closest_left = closest_in_range(candidates[:midpoint])
        closest_right = closest_in_range(candidates[midpoint:])
        left_distance = distance_km(latitude, longitude, closest_left[1][0], closest_left[1][1])
        right_distance = distance_km(latitude, longitude, closest_right[1][0], closest_right[1][1])
        return closest_left if left_distance <= right_distance else closest_right

    name, coordinates = closest_in_range(list(hubs.items()))
    return {
        "name": name,
        "distance": round(distance_km(latitude, longitude, coordinates[0], coordinates[1]), 2),
    }


def build_pickup_route(requests, hubs, settings):
    """Order approved pickups from a hub and estimate each stop's arrival time."""
    starting_hub = settings["starting_hub"]
    current = hubs[starting_hub]
    remaining = [
        item for item in requests
        if item.get("method") == "pickup"
        and item.get("status") == "Approved"
        and isinstance(item.get("latitude"), (int, float))
        and isinstance(item.get("longitude"), (int, float))
        and -90 <= item["latitude"] <= 90
        and -180 <= item["longitude"] <= 180
    ]
    stops = []
    elapsed_minutes = 0
    total_distance = 0.0
    while remaining:
        def stop_key(item):
            distance = distance_km(current[0], current[1], item["latitude"], item["longitude"])
            if settings["sort_by"] == "hazard":
                return (-item["hazard"], distance, item.get("created_at", ""))
            return (distance, -item["hazard"], item.get("created_at", ""))

        next_stop = min(remaining, key=stop_key)
        remaining.remove(next_stop)
        leg_distance = distance_km(
            current[0], current[1], next_stop["latitude"], next_stop["longitude"]
        )
        travel_minutes = math.ceil(leg_distance * 1.3 / 30 * 60)
        elapsed_minutes += travel_minutes
        total_distance += leg_distance
        stops.append({
            "id": next_stop["id"],
            "request_number": next_stop.get("request_number"),
            "name": next_stop["name"],
            "item": next_stop["item"],
            "hazard": next_stop["hazard"],
            "latitude": next_stop["latitude"],
            "longitude": next_stop["longitude"],
            "queue_position": len(stops) + 1,
            "eta_minutes": elapsed_minutes,
            "distance_from_previous_km": round(leg_distance, 2),
        })
        elapsed_minutes += 10
        current = (next_stop["latitude"], next_stop["longitude"])

    return {
        "sort_by": settings["sort_by"],
        "starting_hub": starting_hub,
        "stops": stops,
        "estimated_total_minutes": elapsed_minutes,
        "estimated_total_distance_km": round(total_distance, 2),
    }


def road_route(latitude, longitude, destination, hubs):
    """Use OSRM road routing and fall back to geographic distance if offline."""
    destination_latitude, destination_longitude = hubs[destination]
    fallback = {
        "distance": round(distance_km(latitude, longitude, destination_latitude, destination_longitude), 2),
        "duration": None,
        "source": "geographic estimate",
    }
    url = f"https://router.project-osrm.org/route/v1/driving/{longitude},{latitude};{destination_longitude},{destination_latitude}?overview=false"
    try:
        with urlopen(url, timeout=4) as response:
            route = json.load(response)["routes"][0]
        return {
            "distance": round(route["distance"] / 1000, 2),
            "duration": round(route["duration"] / 60),
            "source": "OSRM road route",
        }
    except (OSError, KeyError, IndexError, TypeError, json.JSONDecodeError):
        return fallback

# Sixth algorithm: Request filtering and sorting by search term and ordering preference.
def filter_and_sort_requests(requests, search, sort_by, hubs):
    """Filter requests by resident/category/item and apply the requested ordering."""
    search = search.strip().lower()
    filtered = [
        item for item in requests
        if not search
        or search in item["name"].lower()
        or search in item["category"].lower()
        or search in item["item"].lower()
    ]
    if sort_by == "item":
        return sorted(filtered, key=lambda item: (item["category"].lower(), item["item"].lower()))
    if sort_by == "shortest":
        return sorted(
            filtered,
            key=lambda item: (
                nearest_hub(item["latitude"], item["longitude"], hubs)["distance"],
                -item["hazard"],
            ),
        )
    return sorted(
        filtered,
        key=lambda item: (-item["hazard"], -item["priority_score"], item["created_at"]),
    )
