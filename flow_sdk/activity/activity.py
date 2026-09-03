"""``Activity`` — the handle a producer holds, and the node the monitor tracks.

Addressed globally by ``(scope, path)`` and found-or-created at every level, so code
deep inside a walk never needs a handle threaded down to it::

    Activity.get("index").label("Indexing").total(5000)
    # ...three modules later, no handle in scope:
    Activity.get("index/pdf").inc_success()
    Activity.get("index/pdf").child("ocr").inc_error("0 pages", ref="b.pdf")

There is no ``start()``: the first mutation moves a node from ``pending`` to
``running`` and stamps ``started_at``. There is no context manager either — a context
manager is a handle by another name, and the whole point is that the address is enough.

The node is MUTABLE; :meth:`Activity.spec` is where the frozen ``DataSpec`` snapshot
comes from. Building that snapshot walks the subtree, so it is deliberately *not* done
on every mutation: subscribers are handed the root node and build a spec only when they
actually emit (see ``flow_sdk/activity/emit.py``). A hundred thousand increments must
cost a hundred thousand integer adds, not a hundred thousand pydantic trees.

Kept pure — stdlib + the spec module, no DB, no WS, no event loop — so the whole state
machine is provable in fast unit tests and the transport is somebody else's problem.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING, Optional

from pydantic.alias_generators import to_snake

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.schema.data_spec.activity_spec import (
    MAX_DEPTH,
    TERMINAL,
    ActivityErrorSpec,
    ActivityProgressSpec,
    ActivityState,
    trim_errors,
)

if TYPE_CHECKING:
    from flow_sdk.activity.progress_monitor import ActivityProgressMonitor

#: Path separator. ``/`` reads as a path and survives a shell argument unquoted, which
#: matters because the CLI form (``flow progress index/pdf inc-success``) is the same
#: address as the Python one.
SEP = "/"


def _now() -> datetime:
    """The one clock. Patch this in tests rather than sleeping."""
    return datetime.now(timezone.utc)


def canonical_verb(verb: str) -> str:
    """``incSuccess`` / ``inc-success`` / ``inc_success`` all name the same verb.

    One vocabulary spelled the way each caller's language spells things — Python and the
    API in snake_case, TypeScript in camel, a shell in kebab. Lives here, beside the verbs
    themselves, so the route and the CLI cannot drift apart on what a spelling means.
    """
    return to_snake(verb.replace("-", "_"))


def split_path(path: str) -> list[str]:
    """``"index/pdf"`` → ``["index", "pdf"]``. Empty segments are dropped, so a stray
    leading or doubled separator addresses the same node rather than a phantom one."""
    return [seg for seg in str(path).split(SEP) if seg]


class Activity:
    """One node in a progress tree. Get it by address; mutate it in place.

    Never constructed directly by producers — :meth:`get` and :meth:`child` go through
    the monitor so that an address resolves to exactly one node, no matter who asks.
    """

    __slots__ = (
        "_monitor",
        "_parent",
        "_children",
        "_root_node",
        "_depth",
        "activity_id",
        "scope",
        "path",
        "name",
        "label_text",
        "icon_name",
        "state",
        "current_item",
        "message_text",
        "done_count",
        "total_count",
        "skipped",
        "errors_count",
        "errors",
        "counters",
        "started_at",
        "updated_at",
        "finished_at",
        "seq",
    )

    def __init__(
        self,
        *,
        monitor: "ActivityProgressMonitor",
        path: str,
        scope: Optional[str] = None,
        parent: "Optional[Activity]" = None,
    ) -> None:
        self._monitor = monitor
        self._parent = parent
        self._children: "dict[str, Activity]" = {}
        # Root and depth are fixed the moment a node exists, so they are computed once
        # rather than re-derived per mutation. On a hot walk `_wake` and `_notify` run per
        # increment, and both used to re-walk the parent chain to find the root.
        self._root_node: "Activity" = self if parent is None else parent._root_node
        segments = split_path(path)
        self._depth = max(len(segments) - 1, 0)
        self.activity_id = mint_uuid()
        self.scope = scope
        self.path = path
        self.name = segments[-1] if segments else path
        self.label_text: Optional[str] = None
        self.icon_name: Optional[str] = None
        self.state = ActivityState.PENDING
        self.current_item: Optional[str] = None
        self.message_text: Optional[str] = None
        self.done_count = 0
        self.total_count: Optional[int] = None
        self.skipped = 0
        self.errors_count = 0
        self.errors: list[ActivityErrorSpec] = []
        self.counters: dict[str, int] = {}
        self.started_at: Optional[datetime] = None
        self.updated_at: Optional[datetime] = None
        self.finished_at: Optional[datetime] = None
        #: Monotonic, bumped on every mutation anywhere in this root's tree. Lives on
        #: the NODE (only a root's is used) rather than in a registry dict: a dict keyed
        #: by ``id()`` would hand a recycled id's counter to an unrelated later object,
        #: and an evicted root would lose the seq its own terminal snapshot needs.
        self.seq = 0

    # ------------------------------------------------------------------ address

    @classmethod
    def get(cls, path: str, scope: Optional[str] = None) -> "Activity":
        """The node at ``path``, created if nobody has touched it yet.

        ``Activity.get("a/b")`` and ``Activity.get("a").child("b")`` are the same node.
        """
        from flow_sdk.activity.progress_monitor import monitor

        return monitor.activity(path, scope=scope)

    def child(self, name: str) -> "Activity":
        """The child called ``name``, created on first touch.

        Raises past :data:`MAX_DEPTH`. That cap is a wire budget, and silently
        flattening or ignoring the call would hide a producer that is about to put a
        per-file node on the socket — the loud failure is the point.
        """
        segs = split_path(name)
        node = self
        for seg in segs:
            node = node._child_segment(seg)
        return node

    def _child_segment(self, seg: str) -> "Activity":
        existing = self._children.get(seg)
        if existing is not None:
            return existing
        if self.depth + 1 > MAX_DEPTH:
            raise ValueError(
                f"activity {self.path!r} is at the depth cap ({MAX_DEPTH}); "
                f"cannot nest {seg!r}. Deep-per-item nodes belong in counters, not children."
            )
        node = Activity(
            monitor=self._monitor,
            path=f"{self.path}{SEP}{seg}",
            scope=self.scope,
            parent=self,
        )
        self._children[seg] = node
        self._monitor._register_node(node)
        return node

    @property
    def depth(self) -> int:
        return self._depth

    @property
    def root(self) -> "Activity":
        return self._root_node

    @property
    def is_root(self) -> bool:
        return self._parent is None

    @property
    def is_terminal(self) -> bool:
        return self.state in TERMINAL

    # ------------------------------------------------------------------ mutation

    def _wake(self, now: datetime) -> None:
        """Stamp this node and every ancestor as alive at ``now``.

        Ancestors are stamped because a parent whose CHILD is working is working: a QA
        cycle's root only orchestrates, and without this it would carry no ``updated_at``
        at all — reported stale by ``monitor.stale()`` while its phases ticked furiously,
        and unsortable against roots that do tick.

        A pending ancestor also starts, for the same reason. Only ``pending`` is moved:
        a deliberately blocked or paused parent is not un-blocked by a child that is
        still draining.
        """
        node: "Optional[Activity]" = self
        while node is not None:
            if node.is_terminal:
                break
            if node.state == ActivityState.PENDING:
                node.state = ActivityState.RUNNING
                node.started_at = now
            node.updated_at = now
            node = node._parent

    def _touch(self) -> "Activity":
        """Common tail of every mutating verb: wake the node, stamp it, notify.

        Returns ``self`` so verbs chain. Every verb has already returned early on a
        terminal node — see :data:`TERMINAL` — so this does not re-check: on a hot walk
        that second check runs per increment and can never be true.
        """
        self._wake(_now())
        self._monitor._notify(self)
        return self

    def label(self, text: Optional[str]) -> "Activity":
        if self.is_terminal:
            return self
        self.label_text = text
        return self._touch()

    def icon(self, name: Optional[str]) -> "Activity":
        if self.is_terminal:
            return self
        self.icon_name = name
        return self._touch()

    def total(self, count: Optional[int]) -> "Activity":
        """Set the denominator. ``None`` means unknown, and unknown is not zero."""
        if self.is_terminal:
            return self
        self.total_count = None if count is None else int(count)
        return self._touch()

    def current(self, item: Optional[str]) -> "Activity":
        """Name what is in hand. Cheap by design: this alone never forces an emit."""
        if self.is_terminal:
            return self
        self.current_item = item
        return self._touch()

    def message(self, text: Optional[str]) -> "Activity":
        if self.is_terminal:
            return self
        self.message_text = text
        return self._touch()

    def inc_success(self, n: int = 1) -> "Activity":
        if self.is_terminal:
            return self
        self.done_count += int(n)
        return self._touch()

    def inc_skipped(self, n: int = 1) -> "Activity":
        """Work passed over rather than performed. It still counts as done: it is
        finished business, and a walk that skips 900 fresh files out of 1000 has not
        got 10% of the way through the folder."""
        if self.is_terminal:
            return self
        n = int(n)
        self.done_count += n
        self.skipped += n
        return self._touch()

    def inc_error(
        self,
        message: str,
        *,
        ref: Optional[str] = None,
        code: Optional[str] = None,
        n: int = 1,
    ) -> "Activity":
        """Record a failure. ``done`` is untouched — a file that errored was not done.

        The count is the truth and the list is a capped sample, so a run against three
        thousand bad inputs reports three thousand and ships ten.
        """
        if self.is_terminal:
            return self
        self.errors_count += int(n)
        self.errors.append(ActivityErrorSpec(message=str(message), ref=ref, code=code, ts=_now()))
        self.errors = trim_errors(self.errors)
        return self._touch()

    def inc(self, counter: str, n: int = 1) -> "Activity":
        """Bump a domain counter by a DELTA — orphans found, chunks embedded."""
        if self.is_terminal:
            return self
        self.counters[counter] = self.counters.get(counter, 0) + int(n)
        return self._touch()

    def set_counter(self, counter: str, value: int) -> "Activity":
        """Set a domain counter to an ABSOLUTE value, never moving it backwards.

        The sibling of :meth:`total`, and the verb a producer wants when its source is a
        running total rather than an event — an agent's token count, a re-parsed
        transcript. Without it every such producer computes ``value - held`` itself and
        invents its own answer for a total that went down, which is a policy that belongs
        in one place. Going backwards is ignored: a re-read that reports less has lost
        information, not undone work.
        """
        if self.is_terminal:
            return self
        value = int(value)
        if value <= self.counters.get(counter, 0):
            return self
        self.counters[counter] = value
        return self._touch()

    # ------------------------------------------------------------------ lifecycle

    def block(self, message: Optional[str] = None) -> "Activity":
        """Stop and say why. Not terminal — a blocked activity is still somebody's."""
        if self.is_terminal:
            return self
        if message is not None:
            self.message_text = message
        self.state = ActivityState.BLOCKED
        if self.started_at is None:
            self.started_at = _now()
        self.updated_at = _now()
        self._monitor._notify(self, transition=True)
        return self

    def pause(self, message: Optional[str] = None) -> "Activity":
        if self.is_terminal:
            return self
        if message is not None:
            self.message_text = message
        self.state = ActivityState.PAUSED
        if self.started_at is None:
            self.started_at = _now()
        self.updated_at = _now()
        self._monitor._notify(self, transition=True)
        return self

    def resume(self) -> "Activity":
        if self.is_terminal:
            return self
        now = _now()
        self._wake(now)
        self.state = ActivityState.RUNNING
        self.updated_at = now
        self._monitor._notify(self, transition=True)
        return self

    def done(self, message: Optional[str] = None) -> "Activity":
        """Finish successfully.

        The node's counter is ``done_count`` precisely so this verb can be called
        ``done`` — the word a producer reaches for is the lifecycle one, and the spec
        still carries the count as ``done``.
        """
        return self._finish(ActivityState.COMPLETED, message)

    def fail(self, message: Optional[str] = None) -> "Activity":
        return self._finish(ActivityState.FAILED, message)

    def cancel(self, message: Optional[str] = None) -> "Activity":
        return self._finish(ActivityState.CANCELLED, message)

    def _finish(self, state: ActivityState, message: Optional[str]) -> "Activity":
        """Reach a terminal state, sticky, and take unfinished children with us.

        A child still running when its root ends did not complete — it was cut off, and
        ``interrupted`` is the word for that. Recording it as ``completed`` would be a
        lie the receipt then carries forever.
        """
        if self.is_terminal:
            return self
        if message is not None:
            self.message_text = message
        now = _now()
        if self._parent is not None:
            self._parent._wake(now)
        self.state = state
        if self.started_at is None:
            self.started_at = now
        self.updated_at = now
        self.finished_at = now
        for node in self.descendants():
            if not node.is_terminal:
                node.state = ActivityState.INTERRUPTED
                node.finished_at = now
                node.updated_at = now
        self._monitor._finished(self)
        return self

    def reset(self) -> "Activity":
        """Back to ``pending``, counters cleared, children dropped.

        For a producer that legitimately re-runs the same address — not for clearing a
        terminal state you would rather not have reported.
        """
        for node in list(self._children.values()):
            self._monitor._unregister_node(node)
        self._children.clear()
        self.state = ActivityState.PENDING
        self.current_item = None
        self.message_text = None
        self.done_count = 0
        self.total_count = None
        self.skipped = 0
        self.errors_count = 0
        self.errors = []
        self.counters = {}
        self.started_at = None
        self.updated_at = _now()
        self.finished_at = None
        self._monitor._notify(self, transition=True)
        return self

    # ------------------------------------------------------------------ read

    def descendants(self) -> "list[Activity]":
        out: "list[Activity]" = []
        for child in self._children.values():
            out.append(child)
            out.extend(child.descendants())
        return out

    def spec(self, _seq: "Optional[int]" = None) -> ActivityProgressSpec:
        """The frozen snapshot. Walks the subtree, so call it when you emit, not on
        every increment.

        ``_seq`` is threaded down internally so a deep tree does not walk to the root once
        per node; callers pass nothing.
        """
        seq = self.root.seq if _seq is None else _seq
        return ActivityProgressSpec(
            activity_id=self.activity_id,
            scope=self.scope,
            path=self.path,
            name=self.name,
            label=self.label_text,
            icon=self.icon_name,
            state=self.state,
            current=self.current_item,
            message=self.message_text,
            done=self.done_count,
            total=self.total_count,
            skipped=self.skipped,
            errors_count=self.errors_count,
            errors=list(self.errors),
            counters=dict(self.counters),
            children=[c.spec(seq) for c in self._children.values()],
            started_at=self.started_at,
            updated_at=self.updated_at,
            finished_at=self.finished_at,
            seq=seq,
        )

    def show(self) -> str:
        """One line per node, for a terminal.

        Renders from :meth:`spec`, so the completed-share rule lives in exactly one place
        (``ActivityProgressSpec.fraction``) rather than being reimplemented over the
        node's own fields.
        """
        root = self.spec()
        lines = []
        for node in root.walk():
            frac = node.fraction()
            pct = f" {round(frac * 100)}%" if frac is not None else ""
            total = f"/{node.total}" if node.total is not None else ""
            errs = f" !{node.errors_count}" if node.errors_count else ""
            indent = "  " * (len(split_path(node.path)) - len(split_path(root.path)))
            lines.append(
                f"{indent}{node.name:<24} {node.state.value:<11} {node.done}{total}{pct}{errs}"
            )
        return "\n".join(lines)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<Activity {self.path!r} {self.state.value} {self.done_count}/{self.total_count}>"



__all__ = ["SEP", "Activity", "canonical_verb", "split_path"]
