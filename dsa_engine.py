"""Compatibility imports for code using the original combined DSA module."""

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
from data_structures import AVLInventoryTree, AVLNode, EwastePriorityQueue, Graph

__all__ = [
    "AVLInventoryTree",
    "AVLNode",
    "EwastePriorityQueue",
    "Graph",
    "distance_km",
    "divide_and_conquer_shortest_path",
    "exhaustive_shortest_path",
    "filter_and_sort_requests",
    "greedy_shortest_path",
    "nearest_hub",
    "priority_score",
    "road_route",
]
