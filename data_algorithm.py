"""Route-finding algorithms for the EcoRoute hub network."""

import heapq
from functools import lru_cache


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
