"""``ActivityProgressSpec`` — what any long-running work reports about itself.

One shape for every producer: an index, a walk, a RAG pass, a QA cycle, an agentic
process. It counts, it names what is in hand, it records errors, it nests, and it ends
in exactly one terminal state. Python, TypeScript, the REST API, the CLI and an agent
all report through it, and every consumer surface (the footer chip, the activity tree,
``flow progress show``) reads this and nothing else.

The shape replaces ``IndexProgressTable`` (a frozen dataclass with a string literal for
its terminal signal and ``total=0`` doubling as "unknown"). Three of that shape's
lessons are encoded here as invariants rather than conventions:

* ``total=None`` means UNKNOWN. Zero means zero. A scan whose discovery *is* the count
  has no total, and a consumer must render a bare count rather than a false 0%.
* ``errors_count`` is the truth and ``errors`` is a capped SAMPLE. A run against three
  thousand encrypted PDFs must cost the wire ten rows, not three thousand, and must
  still say three thousand.
* ``current`` is whatever is actually in hand — a path, a phase, a type. The old field
  held a record-type name, so a long walk of one type showed a frozen label above a
  climbing number.

Frozen, like every ``DataSpec``: this is the snapshot handed to consumers, not the
mutable node. ``flow_sdk.activity.Activity`` is the handle that produces it.
"""

from __future__ import annotations

from datetime import datetime
from typing import ClassVar, Optional

from flow_sdk._compat import StrEnum
from flow_sdk.schema.data_spec.spec import DataSpec


class ActivityState(StrEnum):
    """Where an activity is. Terminal states are STICKY — see :data:`TERMINAL`."""

    PENDING = "pending"
    RUNNING = "running"
    PAUSED = "paused"
    BLOCKED = "blocked"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    #: Assigned by the system, never by a producer: a child still running when its root
    #: ended, or (phase 2) a persisted row found ``running`` after a restart. It is the
    #: signal that distinguishes "the work stopped" from "the work finished", which the
    #: old in-memory-only tracker could not express at all.
    INTERRUPTED = "interrupted"


#: Reaching one of these ends the activity for good. A mutation afterwards is DROPPED,
#: not applied and not raised — a producer that keeps counting past its own terminal is
#: reporting about work that is over, and the snapshot must not move.
TERMINAL: frozenset[ActivityState] = frozenset(
    {
        ActivityState.COMPLETED,
        ActivityState.FAILED,
        ActivityState.CANCELLED,
        ActivityState.INTERRUPTED,
    }
)

#: Wire budget. These are caps on the SHAPE, not conventions for emitters to honour:
#: every snapshot is a complete state pushed on every tick, so the shape's size is the
#: cost of the mechanism. A producer cannot opt out of them by being careless.
MAX_ERROR_SAMPLE = 10
#: Deepest node depth, counting a root as 0. So ``a/b/c/d`` is legal and ``a/b/c/d/e``
#: is not: four tiers is a job, its phases, their parts and a detail — past that a
#: producer is modelling items, and items belong in counters.
MAX_DEPTH = 3

#: How the two halves of the error sample are split when it is trimmed: the FIRST few
#: errors say how a run started going wrong, the LAST few say where it is now. The
#: middle is what ``errors_count`` is for.
_SAMPLE_HEAD = 3


class ActivityErrorSpec(DataSpec):
    """One error, kept as a sample. The count on the activity is the truth."""

    spec_kind: ClassVar[str] = "activity.error"

    message: str
    #: What the error is ABOUT — a path, a TypeId, a test file. Not where it was raised.
    ref: Optional[str] = None
    code: Optional[str] = None
    ts: Optional[datetime] = None


class ActivityProgressSpec(DataSpec):
    """A snapshot of one activity and its children.

    Every tick ships the whole tree, so a consumer can treat any event as complete
    state and needs no replay logic beyond one GET. That is only affordable because
    the shape is capped: see :data:`MAX_ERROR_SAMPLE` and :data:`MAX_DEPTH`.
    """

    spec_kind: ClassVar[str] = "activity.progress"

    #: v4 from ``mint_uuid()``, minted once when the node is created. Nothing derives
    #: it and nothing looks anything up by it — addressing is by ``(scope, path)``,
    #: which is a lookup on the natural key, per the entity-id policy.
    activity_id: str
    #: TypeId this activity belongs to; the default is the ``@local`` compute node.
    #: Scope decides WS routing: a compute-node activity is instance-wide and goes to
    #: every connection, anything else goes to that entity's watchers.
    scope: Optional[str] = None
    #: Address within the scope: ``index``, ``index/pdf``, ``qa.cycle``. Unique per
    #: scope — ``Activity.get(p)`` and ``Activity.get(parent).child(leaf)`` are the
    #: same node.
    path: str
    #: Last segment of ``path``. Denormalised so a row can render without splitting.
    name: str
    label: Optional[str] = None
    #: A lucide export name OR a backend-served path — whatever ``lucideByName``
    #: resolves. An activity is not an entity type, so ``iconForType`` cannot answer
    #: for it; the producer says, or the frontend falls back to the scope entity's
    #: type glyph and then to a generic one.
    icon: Optional[str] = None

    state: ActivityState = ActivityState.PENDING
    #: What is in hand right now. Changing this alone never forces a tick.
    current: Optional[str] = None
    message: Optional[str] = None

    done: int = 0
    #: ``None`` = unknown, and unknown is not zero. Never write 0 to mean "no idea".
    total: Optional[int] = None
    #: A subset of ``done``: work that was passed over rather than performed.
    skipped: int = 0
    errors_count: int = 0
    errors: list[ActivityErrorSpec] = []
    #: Domain numbers with no progress meaning: orphans, chunks embedded, tokens.
    #: Legal as a mapping only because this class carries a ``spec_kind`` — the
    #: authoring form has no map type and short-circuits on a registered kind.
    counters: dict[str, int] = {}
    children: list["ActivityProgressSpec"] = []

    started_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    #: Monotonic per ROOT. A consumer drops any snapshot whose seq is not greater than
    #: what it holds, which is the whole of its out-of-order handling.
    seq: int = 0

    @property
    def is_terminal(self) -> bool:
        return self.state in TERMINAL

    def fraction(self) -> Optional[float]:
        """Completed share in ``[0, 1]``, or ``None`` when genuinely unknowable.

        Own ``total`` wins. Failing that, children that HAVE totals are rolled up —
        a parent that only orchestrates still shows a bar. Failing that, ``None``,
        and the consumer renders a count. Never a fabricated 0.0.
        """
        if self.total:
            return min(self.done / self.total, 1.0)
        known = [c for c in self.children if c.total]
        if not known:
            return None
        total = sum(c.total or 0 for c in known)
        if not total:
            return None
        return min(sum(c.done for c in known) / total, 1.0)

    def walk(self) -> "list[ActivityProgressSpec]":
        """This node and every descendant, depth-first — for counting and searching."""
        out = [self]
        for child in self.children:
            out.extend(child.walk())
        return out

    def find(self, path: str) -> "Optional[ActivityProgressSpec]":
        """The node at an absolute ``path`` within this tree, or ``None``."""
        return next((n for n in self.walk() if n.path == path), None)


def trim_errors(errors: "list[ActivityErrorSpec]") -> "list[ActivityErrorSpec]":
    """Cap an error list to the sample the wire budget allows: first few, then last few.

    Keeping only the tail would lose the first failure, which is usually the one that
    explains the rest; keeping only the head would leave a long run showing errors that
    stopped being current an hour ago.
    """
    if len(errors) <= MAX_ERROR_SAMPLE:
        return list(errors)
    tail = MAX_ERROR_SAMPLE - _SAMPLE_HEAD
    return [*errors[:_SAMPLE_HEAD], *errors[-tail:]]


__all__ = [
    "MAX_DEPTH",
    "MAX_ERROR_SAMPLE",
    "TERMINAL",
    "ActivityErrorSpec",
    "ActivityProgressSpec",
    "ActivityState",
    "trim_errors",
]
