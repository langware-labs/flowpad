"""The stream inbox as a decision subject: a projected message is what a stream inbox rule decides about.

Answers for events whose target is a ``source_item`` — the ``stream_inbox.<provider>.message.projected``
family — with a ``MessageState`` built from the message's hydrated row. Our own and our agents'
messages are never caught: that is the subject's rule, not a setting.
"""

from __future__ import annotations

import logging
from typing import Any, ClassVar

from flow_sdk.automations.decision_subjects import NotCaught
from flow_sdk.schema.data_spec.compute_op_spec import LaunchContext
from flow_sdk.schema.data_spec.decision_spec import YesNoQuestion
from flow_sdk.schema.data_spec.message_state_spec import MessageState, message_head
from flow_sdk.tags.envelope import parse_target

logger = logging.getLogger(__name__)

#: Every tag whose events name a projected message.
MESSAGE_PROJECTED = "stream_inbox.*.message.projected"


class MessageSubject:
    scope_key: ClassVar[str] = "MESSAGE"
    kind: ClassVar[str] = MessageState.spec_kind
    target_type: ClassVar[str] = "source_item"
    tag_patterns: ClassVar[tuple[str, ...]] = (MESSAGE_PROJECTED,)
    when_text: ClassVar[str] = "When a message arrives"

    async def of(self, target: str) -> MessageState:
        from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415

        _, item_id = parse_target(str(target))
        fm = await FlowMessage.get_one({"source_item_id": item_id}) if item_id else None
        if fm is None:
            raise NotCaught("the message is not in the stream inbox")
        return state_of(fm)

    def from_text(self, text: str) -> MessageState:
        return MessageState.from_text(text)

    def question_for(self, sentence: str) -> YesNoQuestion:
        return YesNoQuestion(
            instructions=f"Is this true of the message (`text`, `subject`, from `sender`): {sentence.strip().rstrip('.?')}?"
        )

    def launch_context(self, state: MessageState) -> LaunchContext:
        chips = [f"flow_message-{state.message_id}"] if state.message_id else []
        return LaunchContext(
            shared_context_entities=chips,
            target_typeid_str=f"conversation-{state.conversation_id}" if state.conversation_id else "",
        )

    async def recent(self, trigger: Any, limit: int) -> list[MessageState]:
        """Recent inbound messages on the rule's sources (every source when it names none)."""
        from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415
        from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415
        from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415
        from flow_sdk.stream_inbox.projection import is_message  # noqa: PLC0415

        scoped = (parse_target(s) for s in (getattr(trigger, "tag_scope", None) or []))
        sources = [sid for stype, sid in scoped if stype == "data_source" and sid]
        # Newest first from the database; a few more than asked, since own and outbound messages are
        # refused after the read. Then every message row in ONE query.
        items = await SourceItem.get_all(QueryFilter(
            match=ExpressionNode(op=QueryOp.IN, operands=["data_source_id", sources]) if sources else None,
            order_by=[{"occurred_at": "desc"}, {"created_date": "desc"}],
            limit=limit * 3,
        )) or []
        items = [i for i in items if is_message(i)]
        if not items:
            return []
        messages = await FlowMessage.get_all(QueryFilter(
            match=ExpressionNode(op=QueryOp.IN, operands=["source_item_id", [str(i.id) for i in items]]),
        )) or []
        by_item = {str(fm.source_item_id): fm for fm in messages}
        out: list[MessageState] = []
        for item in items:
            fm = by_item.get(str(item.id))
            if fm is None:
                continue
            try:
                out.append(state_of(fm))
            except NotCaught:
                continue
            if len(out) >= limit:
                break
        return out

    def subject_id(self, state: MessageState) -> str:
        return state.message_id

    async def by_id(self, subject_id: str) -> MessageState:
        return state_of(await _message(subject_id))

    async def test_event(self, subject_id: str) -> dict[str, Any]:
        """The projected envelope the message arrived on, minus its tag (the caller's own sample)."""
        from flow_sdk.stream_inbox.stream_inbox_on_tag import projected_envelope  # noqa: PLC0415

        fm = await _message(subject_id)
        if not fm.source_item_id:
            raise LookupError("that message did not come in on a channel")
        origin = getattr(fm, "origin_local", None)
        envelope = projected_envelope("", str(fm.source_item_id), str(getattr(origin, "data_source_id", "") or ""))
        return {key: envelope[key] for key in ("target", "data", "scope") if key in envelope}

    def on_fired(self, state: MessageState, event: Any) -> None:
        """The existing handling notice, on the cause's own provider segment."""
        from flow_sdk.stream_inbox.stream_inbox_on_tag import emit_message_status  # noqa: PLC0415

        try:
            segment = str(getattr(event, "tag", "") or "").split(".")[1]
            source_id = str((getattr(event, "data", None) or {}).get("source_id") or "")
            if source_id:
                emit_message_status(_Source(source_id, segment), state.origin_key or state.message_id)
        except Exception:  # noqa: BLE001 — a notice, never the fire
            logger.debug("handling notice failed", exc_info=True)


class _Source:
    """What ``emit_message_status`` reads off a source — the id and the provider the cause tag names —
    so the notice is the ONE emitter's, without loading the row on the fire path."""

    __slots__ = ("id", "provider")

    def __init__(self, source_id: str, provider: str) -> None:
        self.id = source_id
        self.provider = provider


async def _message(message_id: str) -> Any:
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415

    fm = await FlowMessage.get_by_id(message_id) if message_id else None
    if fm is None:
        raise LookupError("no such message")
    return fm


def state_of(fm: Any) -> MessageState:
    """A ``FlowMessage`` (hydrated) as the state. Our own and our agents' messages are refused."""
    from flow_sdk.schema.data_spec.message_sender_spec import SenderKind  # noqa: PLC0415

    sender = getattr(fm, "sender", None)
    if getattr(fm, "outbound", False) or (sender is not None and sender.kind in (SenderKind.USER, SenderKind.AGENT)):
        raise NotCaught("own message")
    envelope = getattr(fm, "envelope", None)
    who = ""
    if envelope is not None and envelope.sender is not None:
        name = str(getattr(envelope.sender, "name", "") or "")
        address = str(getattr(envelope.sender, "email", "") or getattr(envelope.sender, "address", "") or "")
        who = f"{name} <{address}>" if name and address else name or address
    if not who:
        who = str(getattr(fm, "sender_name", "") or "") or (
            f"{sender.channel}:{sender.address}" if sender is not None and sender.kind is SenderKind.EXTERNAL else ""
        )
    origin = getattr(fm, "origin", None)
    channel = str(getattr(origin, "channel", "") or getattr(origin, "provider", "") or "")
    text = str(getattr(fm, "text", "") or "")
    head, cut = message_head(text)
    received = getattr(fm, "received_at", None) or (envelope.sent_at if envelope is not None else None)
    return MessageState(
        channel=channel,
        sender=who,
        subject=str(getattr(envelope, "subject", "") or "") if envelope is not None else "",
        text=head,
        text_cut=cut,
        received_at=received.isoformat() if hasattr(received, "isoformat") else (str(received) if received else None),
        conversation_id=str(getattr(fm, "conversation_id", "") or ""),
        message_id=str(getattr(fm, "id", "") or ""),
        origin_key=str(getattr(origin, "key", "") or ""),
        files=[str(getattr(a, "name", "") or getattr(a, "filename", "") or "") for a in (getattr(fm, "attachment", None) or [])],
    )
