"""The last snapshot of every activity tree, as the wire saw it.

A finished root is evicted, so a test that wants to read a run's tree AFTER the run asks
for what was emitted, not for the address (which would mint a fresh, empty node).
"""

from contextlib import contextmanager
from typing import Iterator, Optional

from flow_sdk.activity import monitor
from flow_sdk.schema.data_spec.activity_spec import ActivityProgressSpec


class Trees:
    def __init__(self) -> None:
        self._roots: dict = {}

    def record(self, root, _transition) -> None:
        # The node, not a snapshot: an evicted root still holds its finished tree, so the
        # spec is built once, when a test asks, rather than on every tick.
        self._roots[(root.subject_entity, root.path)] = root

    def at(self, path: str, subject_entity: Optional[str] = None) -> Optional[ActivityProgressSpec]:
        """The last snapshot of the node at ``path`` (searched in its root's tree)."""
        root = self._roots.get((subject_entity, path.split("/")[0]))
        return root.spec().find(path) if root is not None else None


@contextmanager
def recorded_trees() -> Iterator[Trees]:
    trees = Trees()
    unsubscribe = monitor.subscribe(trees.record)
    try:
        yield trees
    finally:
        unsubscribe()
