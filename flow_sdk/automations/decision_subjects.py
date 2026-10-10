"""Decision subjects — what a rule's gate is asked ABOUT, by the kind of thing an event names.

A TAG trigger's event names a target (``source_item:<id>``). A **subject** knows how to turn
that target into the one value the rule's ``if`` decides about and its ``then`` receives: it
builds the state, words a person's sentence into a question over that state's own field
names, says how the agent's session should be linked back, and lists recent states to try
a rule on. The automation layer asks the registry; it never names a message, a task or a
provider itself.

A subject registers for a target TYPE and for the tag patterns whose events carry it, so a
rule being written (no event yet, only a pattern) finds its subject too.
"""

from __future__ import annotations

from typing import Any, Optional, Protocol, runtime_checkable

from flow_sdk.schema.data_spec.compute_op_spec import LaunchContext
from flow_sdk.schema.data_spec.decision_spec import YesNoQuestion
from flow_sdk.schema.data_spec.spec import DataSpec


class NotCaught(Exception):
    """The subject refuses this event before any question is asked (the message is our own).
    Recorded as a declined fire with ``reason``; never a failure."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@runtime_checkable
class DecisionSubject(Protocol):
    #: The scope name the state travels under into the rule's wizard.
    scope_key: str
    #: The state's registered kind (what the snippet page names; the machinery reads ``scope_key``).
    kind: str
    #: The event target type this subject answers for (``source_item``).
    target_type: str
    #: How a rule on this subject's events reads: "When a message arrives". Empty → the event's own name.
    when_text: str
    #: Tag patterns whose events carry that target (``stream_inbox.*.message.projected``).
    tag_patterns: tuple[str, ...]

    async def of(self, target: str) -> DataSpec:
        """The state for one event target (``type:id``). Raises ``NotCaught`` to decline."""

    def from_text(self, text: str) -> DataSpec:
        """A state with no row behind it — what a fast test types in."""

    def question_for(self, sentence: str) -> YesNoQuestion:
        """A person's sentence as a yes/no question over this state's own field names."""

    def launch_context(self, state: DataSpec) -> LaunchContext:
        """How an agent's session is keyed and chipped for this state."""

    async def recent(self, trigger: Any, limit: int) -> list[DataSpec]:
        """Recent states a rule like ``trigger`` would be asked about, newest first."""

    def subject_id(self, state: DataSpec) -> str:
        """The id a run row keeps so the state can be rebuilt and the thing opened."""

    async def by_id(self, subject_id: str) -> DataSpec:
        """The state for a ``subject_id`` — the inverse of ``subject_id``. Raises ``LookupError`` when
        there is no such thing, ``NotCaught`` to decline it."""

    async def test_event(self, subject_id: str) -> dict[str, Any]:
        """The envelope parts (``target``, ``data``, ``scope``) the real event for that thing carried —
        what a test run fires with. Raises ``LookupError`` when it is not something a rule can run on."""

    def on_fired(self, state: DataSpec, event: Any) -> None:
        """Announce that an agent has taken this state up (best effort, never raises)."""


_SUBJECTS: list[DecisionSubject] = []
_loaded = False


def register(subject: DecisionSubject) -> None:
    for i, known in enumerate(_SUBJECTS):
        if known.target_type == subject.target_type:
            _SUBJECTS[i] = subject
            return
    _SUBJECTS.append(subject)


def _builtin() -> None:
    """The subjects Flowpad ships, reachable on first ask (import-time registration elsewhere
    would make ``automations`` import the stream inbox for every caller that never decides)."""
    global _loaded
    if _loaded:
        return
    _loaded = True
    from flow_sdk.stream_inbox.message_subject import MessageSubject  # noqa: PLC0415

    register(MessageSubject())


def all_subjects() -> list[DecisionSubject]:
    _builtin()
    return list(_SUBJECTS)


def for_target(target: str) -> Optional[DecisionSubject]:
    """The subject for an event target in colon form (``source_item:<id>``)."""
    from flow_sdk.tags.envelope import parse_target  # noqa: PLC0415

    ttype, _ = parse_target(str(target or ""))
    return next((s for s in all_subjects() if s.target_type == ttype), None) if ttype else None


def for_pattern(pattern: str) -> Optional[DecisionSubject]:
    """The subject whose events a tag pattern would receive — for a rule with no event yet."""
    from flow_sdk.tags.grammar import tag_matches  # noqa: PLC0415

    pattern = str(pattern or "")
    if not pattern:
        return None
    for subject in all_subjects():
        for own in subject.tag_patterns:
            # Either side may be the glob: a rule on `stream_inbox.*.message.projected` and a subject
            # declaring the same, or a rule on one provider's tag under the subject's family.
            if tag_matches(pattern, own.replace("*", "x")) or tag_matches(own, pattern.replace("*", "x")):
                return subject
    return None


def for_trigger(trigger: Any) -> Optional[DecisionSubject]:
    return for_pattern(str(getattr(trigger, "tag_pattern", "") or ""))


def gate_for(pattern: str, sentence: str) -> dict:
    """A string ``if`` (the sentence a person typed) as the decision op the subject words —
    the row's ``gate`` dict. Raises ``LookupError`` when no subject answers for the pattern."""
    from flow_sdk.schema.data_spec.compute_op_spec import DecisionOp  # noqa: PLC0415

    subject = for_pattern(str(pattern or ""))
    if subject is None:
        raise LookupError(f"nothing knows what a rule on {pattern!r} would decide about")
    op = DecisionOp.from_sentence(sentence, question=subject.question_for(sentence))
    return op.model_copy(update={"input": subject.scope_key}).model_dump(mode="json", exclude_defaults=False)
