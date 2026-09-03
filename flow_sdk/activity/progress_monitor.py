"""``ActivityProgressMonitor`` — the in-memory tracker every activity lives in.

It IS the find-or-create registry: ``Activity.get`` goes through it, so an address
resolves to exactly one node no matter who asks, and two callers who ask for the same
path get the same object rather than two rows that disagree.

It tracks LIVE work only. When a **root** reaches a terminal state its whole subtree is
untracked, and the ordering around that is a contract rather than an implementation
detail::

    1. build the terminal snapshot   (sticky state, finished_at, children interrupted)
    2. [phase 2] persist the receipt
    3. publish the transition on the event bus
    4. untrack the subtree

Persist lands between 1 and 2 in phase 2; the steps are separated here so that insert is
a line, not a redesign. Phase 1 is memory only, and the consequence is worth stating
plainly: after eviction ``Activity.get("index")`` returns a FRESH pending node, not the
finished one. "Is it running" is a question for this monitor; "when did it last finish"
is a question for the receipt. The tracker it replaces conflated those, which is why a
backend restart used to make the footer indicator vanish with nothing said.

Process-local and unpersisted, so it dies with the process. Deliberately: a progress
tracker that outlived its producer would report work that nobody is doing.

The module is ``progress_monitor`` and the singleton is ``monitor`` — a module also
called ``monitor`` would be shadowed by the singleton on the package, and every
``flow_sdk.activity.monitor`` would then be ambiguous to a reader and to monkeypatch.
"""

from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional

from flow_sdk.activity import activity as _activity
from flow_sdk.activity.activity import SEP, Activity, split_path
from flow_sdk.schema.data_spec.activity_spec import ActivityProgressSpec

#: A subscriber is handed the ROOT node, not a built spec. Building a spec walks the
#: subtree, and a subscriber that coalesces (the WS sink does) should pay that cost only
#: when it actually emits — not on every one of a hundred thousand increments.
Subscriber = Callable[[Activity, bool], None]


def _norm(path: str) -> str:
    """Canonical address, so ``"/index//pdf"`` and ``"index/pdf"`` key the same node."""
    return SEP.join(split_path(path))

class ActivityProgressMonitor:
    """Tracks every live activity on this box. One instance, module-level below."""

    def __init__(self) -> None:
        #: ``(scope, root_path) -> root Activity``. Roots only; children are reached
        #: through their root, which is what makes eviction a single delete.
        self._roots: "dict[tuple[Optional[str], str], Activity]" = {}
        #: Every node by full address, for O(1) ``get`` on a deep path.
        self._nodes: "dict[tuple[Optional[str], str], Activity]" = {}
        #: A TUPLE, swapped wholesale on subscribe/unsubscribe. ``_notify`` runs once per
        #: mutation — a hundred thousand times on a walk — and reading an immutable
        #: attribute needs neither the lock nor the defensive copy a list would.
        self._subscribers: "tuple[Subscriber, ...]" = ()
        #: Re-entrant: a subscriber may legitimately read the tree it was handed.
        self._lock = threading.RLock()

    # ------------------------------------------------------------------ addressing

    def activity(self, path: str, scope: Optional[str] = None) -> Activity:
        """Find-or-create the node at ``(scope, path)``, creating ancestors as needed.

        Addressing a deep path directly is the same as walking to it, so a producer
        three modules from the root needs no handle passed down.
        """
        segs = split_path(path)
        if not segs:
            raise ValueError("activity path must have at least one segment")
        with self._lock:
            key = (scope, SEP.join(segs))
            existing = self._nodes.get(key)
            if existing is not None:
                return existing
            root = self._root(segs[0], scope)
            node = root
            for seg in segs[1:]:
                node = node._child_segment(seg)
            return node

    def _root(self, name: str, scope: Optional[str]) -> Activity:
        key = (scope, name)
        root = self._roots.get(key)
        if root is None:
            root = Activity(monitor=self, path=name, scope=scope)
            self._roots[key] = root
            self._nodes[key] = root
        return root

    def _register_node(self, node: Activity) -> None:
        """Called by ``Activity._child_segment`` so deep addresses stay O(1)."""
        self._nodes[(node.scope, node.path)] = node

    def _unregister_node(self, node: Activity) -> None:
        for desc in node.descendants():
            self._nodes.pop((desc.scope, desc.path), None)
        self._nodes.pop((node.scope, node.path), None)

    # ------------------------------------------------------------------ emission

    def subscribe(self, fn: Subscriber) -> "Callable[[], None]":
        """Register a sink. Returns an unsubscribe callable."""
        with self._lock:
            self._subscribers = (*self._subscribers, fn)

        def _unsubscribe() -> None:
            with self._lock:
                self._subscribers = tuple(s for s in self._subscribers if s is not fn)

        return _unsubscribe

    def _notify(self, node: Activity, transition: bool = False) -> None:
        """Bump the root's seq and hand the root to every subscriber.

        A subscriber that raises must not break the producer: progress reporting is
        never the reason a walk fails. The exception is swallowed here and the sink is
        expected to do its own logging.

        No lock: the seq lives on the node (a ``+= 1`` under the GIL) and the subscriber
        tuple is swapped atomically, so the common case — a walk in a process with no sink
        attached — costs one integer add.
        """
        root = node.root
        root.seq += 1
        subscribers = self._subscribers
        if not subscribers:
            return
        for fn in subscribers:
            try:
                fn(root, transition)
            except Exception:  # noqa: BLE001 — a sink must never fail a producer
                pass

    def _finished(self, node: Activity) -> None:
        """A node reached a terminal state. Emit, then evict if it was a root.

        A CHILD terminal leaves the tree tracked — a finished phase of a running cycle
        is still part of live work, and dropping it would make the tree lie about what
        it did. Only a root terminal ends the tracking.
        """
        self._notify(node, transition=True)
        if node.is_root:
            with self._lock:
                self._roots.pop((node.scope, node.path), None)
                self._unregister_node(node)

    # ------------------------------------------------------------------ reading

    def get(self, path: str, scope: Optional[str] = None) -> Optional[ActivityProgressSpec]:
        """The tree at an address, or ``None`` once it is gone.

        ``None`` is the honest answer for a completed root: the monitor holds live work,
        and asking it about finished work is asking the wrong component.
        """
        with self._lock:
            node = self._nodes.get((scope, _norm(path)))
        return node.spec() if node is not None else None

    def node(self, path: str, scope: Optional[str] = None) -> Optional[Activity]:
        """The live node without creating one. For callers that must not mint."""
        with self._lock:
            return self._nodes.get((scope, _norm(path)))

    def list(self, scope: Optional[str] = None, *, all_scopes: bool = False) -> "list[ActivityProgressSpec]":
        """Live roots, newest activity first. ``all_scopes`` ignores the scope filter."""
        with self._lock:
            roots = [
                r
                for (s, _p), r in self._roots.items()
                if all_scopes or s == scope
            ]
        # A timezone-AWARE floor: every real stamp is aware, and mixing the two raises
        # rather than sorting. A root can genuinely have neither stamp — it was addressed
        # but never mutated — so the floor has to be reachable.
        return sorted(
            (r.spec() for r in roots),
            key=lambda s: s.updated_at or s.started_at or datetime.min.replace(tzinfo=timezone.utc),
            reverse=True,
        )

    def count(self, scope: Optional[str] = None, *, all_scopes: bool = True) -> int:
        """How many roots are live. Roots, not nodes: the chip counts activities, and a
        cycle with twelve phases is one activity to a person looking at a badge."""
        with self._lock:
            if all_scopes:
                return len(self._roots)
            return sum(1 for (s, _p) in self._roots if s == scope)

    def stale(self, seconds: float) -> "list[ActivityProgressSpec]":
        """Roots with no tick inside the window.

        This is the only component that knows when each activity last moved, so it is
        the only one that can tell a slow job from a hung one. It REPORTS; it never
        kills and never turns silence into a failure. Timing something out here would
        be a wait budget, and those are not ours to invent.
        """
        now = _activity._now()
        cutoff = now - timedelta(seconds=seconds)
        with self._lock:
            roots = list(self._roots.values())
        return [r.spec() for r in roots if (r.updated_at or r.started_at or now) < cutoff]

    def drop(self, path: str, scope: Optional[str] = None) -> bool:
        """Force-untrack a root whose producer died without a terminal. Rare by design:
        the honest default is that such a root goes stale and says so."""
        with self._lock:
            key = (scope, _norm(path))
            root = self._roots.pop(key, None)
            if root is None:
                return False
            self._unregister_node(root)
            return True

    def clear(self) -> None:
        """Drop everything. For tests and for a clean shutdown."""
        with self._lock:
            self._roots.clear()
            self._nodes.clear()


#: The one monitor. ``Activity.get`` resolves through this.
monitor = ActivityProgressMonitor()


__all__ = ["ActivityProgressMonitor", "Subscriber", "monitor"]
