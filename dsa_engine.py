"""Compatibility imports for code using the original combined DSA module."""

from data_algorithm import (
    divide_and_conquer_shortest_path,
    exhaustive_shortest_path,
    greedy_shortest_path,
)
from data_structures import AVLInventoryTree, AVLNode, EwastePriorityQueue, Graph

__all__ = [
    "AVLInventoryTree",
    "AVLNode",
    "EwastePriorityQueue",
    "Graph",
    "divide_and_conquer_shortest_path",
    "exhaustive_shortest_path",
    "greedy_shortest_path",
]
