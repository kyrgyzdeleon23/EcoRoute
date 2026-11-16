"""Data structures used by EcoRoute's routing, requests, and inventory."""

import heapq


# First data structure: weighted graph stored as an adjacency list.
class Graph:
    """Weighted undirected graph of hubs and their connecting distances."""

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


# Second data structure: heap-based priority queue for e-waste requests.
class EwastePriorityQueue:
    """Binary-heap max-priority queue for e-waste requests.

    Negated scores let Python's min-heap return the highest-scoring request
    first; the counter preserves insertion order when scores tie.
    """

    def __init__(self):
        self.heap = []
        self.counter = 0

    def add_request(self, item_id, donor, category, weight, hazard, urgency, station):
        """Score a request and insert it into the heap."""
        score = -(urgency * 3 + hazard * 2 + (weight / 10))
        entry = {
            "id": item_id,
            "donor": donor,
            "category": category,
            "weight": weight,
            "hazard": hazard,
            "urgency": urgency,
            "station": station,
            "priority_score": abs(score),
        }
        heapq.heappush(self.heap, (score, self.counter, entry))
        self.counter += 1

    def get_prioritized_list(self):
        sorted_heap = sorted(self.heap, key=lambda x: x[0])
        return [item[2] for item in sorted_heap]

    def peek(self):
        """Return the highest-priority request without removing it."""
        return self.heap[0][2] if self.heap else None

    def remove_request(self, item_id):
        self.heap = [item for item in self.heap if item[2]["id"] != item_id]
        heapq.heapify(self.heap)


# Third data structure: AVL tree for inventory categories.
class AVLNode:
    """One category node in the AVL inventory tree."""

    def __init__(self, key, item):
        self.key = key
        self.items = [item]
        self.height = 1
        self.left = None
        self.right = None


class AVLInventoryTree:
    """AVL self-balancing binary search tree keyed by waste category.

    Each node groups items in the same category, and subtree heights are kept
    balanced after insertions and deletions for efficient lookup.
    """

    def __init__(self):
        self.root = None

    def get_height(self, node):
        return node.height if node else 0

    def get_balance(self, node):
        return self.get_height(node.left) - self.get_height(node.right) if node else 0

    def right_rotate(self, y):
        """Rotate a left-heavy subtree to restore AVL balance."""
        x = y.left
        T2 = x.right
        x.right = y
        y.left = T2
        y.height = max(self.get_height(y.left), self.get_height(y.right)) + 1
        x.height = max(self.get_height(x.left), self.get_height(x.right)) + 1
        return x

    def left_rotate(self, x):
        """Rotate a right-heavy subtree to restore AVL balance."""
        y = x.right
        T2 = y.left
        y.left = x
        x.right = T2
        x.height = max(self.get_height(x.left), self.get_height(x.right)) + 1
        y.height = max(self.get_height(y.left), self.get_height(y.right)) + 1
        return y

    def insert(self, root, key, item):
        """Insert an item under its category, then rebalance the subtree."""
        if not root:
            return AVLNode(key, item)
        if key < root.key:
            root.left = self.insert(root.left, key, item)
        elif key > root.key:
            root.right = self.insert(root.right, key, item)
        else:
            root.items.append(item)
            return root

        root.height = 1 + max(self.get_height(root.left), self.get_height(root.right))
        balance = self.get_balance(root)

        if balance > 1 and key < root.left.key:
            return self.right_rotate(root)
        if balance < -1 and key > root.right.key:
            return self.left_rotate(root)
        if balance > 1 and key > root.left.key:
            root.left = self.left_rotate(root.left)
            return self.right_rotate(root)
        if balance < -1 and key < root.right.key:
            root.right = self.right_rotate(root.right)
            return self.left_rotate(root)

        return root

    def in_order_traversal(self, root, result=None):
        """Return categories in sorted order using an in-order traversal."""
        if result is None:
            result = []
        if root:
            self.in_order_traversal(root.left, result)
            result.append({"category": root.key, "items": root.items})
            self.in_order_traversal(root.right, result)
        return result

    def search(self, root, key):
        """Find one category node in O(log n) average balanced-tree time."""
        current = root
        while current:
            if key == current.key:
                return {"category": current.key, "items": current.items}
            current = current.left if key < current.key else current.right
        return None

    def _minimum_node(self, node):
        current = node
        while current.left:
            current = current.left
        return current

    def delete(self, root, key, item_id=None):
        """Delete a category or one item from a category and rebalance."""
        if not root:
            return None
        if key < root.key:
            root.left = self.delete(root.left, key, item_id)
        elif key > root.key:
            root.right = self.delete(root.right, key, item_id)
        else:
            if item_id is not None:
                root.items = [item for item in root.items if item.get("id") != item_id]
                if root.items:
                    return root
            if not root.left:
                return root.right
            if not root.right:
                return root.left
            successor = self._minimum_node(root.right)
            root.key, root.items = successor.key, successor.items
            root.right = self.delete(root.right, successor.key)

        root.height = 1 + max(self.get_height(root.left), self.get_height(root.right))
        balance = self.get_balance(root)
        if balance > 1 and self.get_balance(root.left) >= 0:
            return self.right_rotate(root)
        if balance > 1:
            root.left = self.left_rotate(root.left)
            return self.right_rotate(root)
        if balance < -1 and self.get_balance(root.right) <= 0:
            return self.left_rotate(root)
        if balance < -1:
            root.right = self.right_rotate(root.right)
            return self.left_rotate(root)
        return root
