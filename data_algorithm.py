"""Graph algorithms used to compare routes between EcoRoute hubs."""

import heapq


class Graph:
    """Weighted undirected graph stored as an adjacency list.

    Hubs are vertices and the distances between connected hubs are edge
    weights.
    """

    def __init__(self):
        self.adj = {}

    def add_station(self, name):
        if name not in self.adj:
            self.adj[name] = []

    def add_edge(self, u, v, weight):
        self.add_station(u)
        self.add_station(v)
        self.adj[u].append((v, weight))
        self.adj[v].append((u, weight))

    def shortest_path(self, start, end):
        """Use Dijkstra's greedy algorithm to find a shortest route.

        At each step, the min-heap selects the unvisited hub with the smallest
        known distance from the start.
        """
        pq = [(0, start, [start])]
        visited = set()

        while pq:
            cost, current, path = heapq.heappop(pq)
            if current in visited:
                continue
            visited.add(current)

            if current == end:
                return {"distance": cost, "path": path}

            for neighbor, weight in self.adj.get(current, []):
                if neighbor not in visited:
                    heapq.heappush(pq, (cost + weight, neighbor, path + [neighbor]))

        return {"distance": float("inf"), "path": []}

    def shortest_path_exhaustive(self, start, end):
        """Exhaustively check simple routes and return the shortest one.

        This is intended for small networks only; the 10-hub limit prevents
        the combinatorial route search from growing without bound.
        """
        if len(self.adj) > 10:
            raise ValueError("Exhaustive route search supports networks with at most 10 hubs")
        if start not in self.adj or end not in self.adj:
            return {"distance": float("inf"), "path": []}

        shortest = {"distance": float("inf"), "path": []}

        def visit(current, visited, path, distance):
            if current == end:
                if distance < shortest["distance"]:
                    shortest.update(distance=distance, path=path.copy())
                return

            for neighbor, weight in self.adj[current]:
                if neighbor not in visited and distance + weight < shortest["distance"]:
                    visited.add(neighbor)
                    path.append(neighbor)
                    visit(neighbor, visited, path, distance + weight)
                    path.pop()
                    visited.remove(neighbor)

        visit(start, {start}, [start], 0)
        return shortest
