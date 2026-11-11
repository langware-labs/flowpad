"""One step of a dotted field path: a dict key, a list index, or an object's attribute.

No dependencies, so every layer can walk paths the same way: the dataset query grammar
(``flow_sdk.datasets.query.field_of``), the entity store's filters and sorts, and search text."""

from __future__ import annotations

from typing import Any


def step(at: Any, name: str) -> Any:
    """``at``'s value named ``name`` — None when there is none."""
    if isinstance(at, dict):
        return at.get(name)
    if isinstance(at, (list, tuple)):
        return at[int(name)] if name.isdigit() and int(name) < len(at) else None
    if at is None or isinstance(at, (str, int, float, bool)):
        return None
    return getattr(at, name, None)


def walk(obj: Any, path: str) -> Any:
    """The value at a dotted ``path`` on ``obj`` (no ``*``, no links — that is ``field_of``)."""
    current = obj
    for name in path.split("."):
        current = step(current, name)
        if current is None:
            return None
    return current
