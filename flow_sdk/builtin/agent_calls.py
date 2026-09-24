"""An agent on a live call — the voice counterpart of :func:`agent_serve.answer`.

A channel message is answered by one turn and one reply. A call is a conversation in real time,
so its shape differs, but it lands in exactly the same places:

* **Every sentence is a message.** What the caller said (``heard``) and what the voice said
  (``said``) go through the one ingestion chokepoint as ``VoiceTurnData`` and are projected into the
  call's own thread — one conversation per call, start to end — which reads in the stream inbox like
  any chat, on any voice channel.
* **The agent is the brain.** When the voice asks (``delegate``), the request runs as an ordinary
  :class:`~flow_sdk.builtin.agent_serve.Turn` in that conversation's session — the same process and
  memory that answers the caller on every other channel — and the answer is handed back to be spoken.
* **Visible while it happens.** The call opens with a marker message, "Call with <caller>" (so its
  conversation exists, titled, before anyone speaks); a caller mid-sentence is announced as ``voice.call.partial``; the agent's own
  turn is the conversation's process, which the conversation view already follows live.

Which transport carried the audio — a phone line, a browser, a sound file — is the source's
business (its ``accept``); nothing below knows it.
"""

from __future__ import annotations

import asyncio
import itertools
import logging
from datetime import datetime, timezone
from typing import Any, Optional

from flow_sdk.sources.values.call import CallEvent, IncomingCall

logger = logging.getLogger(__name__)

#: The live calls on this process: call id → the task holding it and its session once accepted.
_CALLS: dict[str, dict[str, Any]] = {}
_SEQ = itertools.count(1)

CALL_ENDED = "Call ended"


def call_started(call: IncomingCall) -> str:
    """The call's opening line — the thread's title, so the stream inbox says who the call was with."""
    return f"Call with {call.caller_name or call.caller}"


def answers_live(source) -> bool:
    """Whether *source*'s channel is one people talk to live (a ``Calling`` driver)."""
    from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415

    driver = DataDriver.loaded(str(getattr(source, "provider", "") or ""))
    return driver is not None and hasattr(driver.cls, "start_call") and hasattr(driver.cls, "accept")


def active_calls() -> dict[str, dict[str, Any]]:
    """Call id → ``{source_id, caller, conversation_id}`` for every call on the line here."""
    return {k: {n: v.get(n) for n in ("source_id", "caller", "conversation_id")} for k, v in _CALLS.items()}


def voice_instructions(agent, call: IncomingCall) -> str:
    """What the voice is told: it speaks for the agent and knows nothing on its own."""
    who = call.caller_name or call.caller or "the caller"
    name = str(getattr(agent, "name", "") or "the agent")
    lines = [
        f"You are the voice of {name}, on a live call with {who}.",
        "Speak briefly and naturally, in the caller's language.",
        "You know nothing yourself: for any question, request or fact, call ask_agent with the caller's full "
        "request, say a short filler while you wait, then say its answer in your own words.",
    ]
    if call.brief:
        lines.append(f"You placed this call. Its purpose: {call.brief}. Open by greeting them and saying why you call.")
    return " ".join(lines)


def turn_body(call: IncomingCall, request: str) -> str:
    """A delegated request as the agent's turn: said on a call, so the answer is for speaking."""
    return (
        f"[Live voice call with {call.caller_name or call.caller}] The caller asks: {request}\n"
        "Answer in one to three short sentences that can be spoken aloud — no markdown, no lists."
    )


async def ring(source, call: IncomingCall) -> bool:
    """A call reached *source*: answer it on this machine, in the background. ``False`` when nothing here answers it."""
    from flow_sdk.builtin.agent import Agent  # noqa: PLC0415
    from flow_sdk.builtin.agent_serve import TurnEngine, answers_here  # noqa: PLC0415
    from flow_sdk.request_context.detached import create_detached_task  # noqa: PLC0415
    from flow_sdk.schema.types import EntityType  # noqa: PLC0415
    from flow_sdk.stream_inbox.projection import owner_of  # noqa: PLC0415

    owner = await owner_of(source)
    agent = await Agent.get_by_id(owner.id) if owner is not None and owner.type == EntityType.AGENT.value else None
    if agent is None:
        logger.warning("[voice] call %s on %s: the source is not an agent's — nobody answers", call.call_id, source.id)
        return False
    deployment = await agent.local_deployment()
    if not await answers_here(source, deployment):
        logger.info("[voice] call %s on %s is answered elsewhere", call.call_id, source.id)
        return False
    engine = TurnEngine(agent, deployment)
    _CALLS[call.call_id] = {"source_id": str(source.id), "caller": call.caller}
    _CALLS[call.call_id]["task"] = create_detached_task(answer_call(engine, source, call), name=f"voice-call:{call.call_id}")
    return True


async def hangup(call_id: str) -> bool:
    entry = _CALLS.get(call_id)
    session = entry.get("session") if entry else None
    if session is None:
        return False
    await session.hangup()
    return True


async def answer_call(engine, source, call: IncomingCall) -> Optional[str]:
    """Hold one call to its end. Answers the conversation it was placed in, or ``None`` when refused."""
    from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415

    driver = DataDriver.loaded(source.provider)
    live_source = await driver.open(source)
    entry = _CALLS.setdefault(call.call_id, {"source_id": str(source.id), "caller": call.caller})
    try:
        # The source's session spans the call: what it holds the call with is released when the call ends.
        async with live_source:
            return await _hold(engine, driver, live_source, source, call, entry)
    except Exception:  # noqa: BLE001 — a call that breaks is logged; the line is released
        logger.exception("[voice] call %s on %s failed", call.call_id, source.id)
        return entry.get("conversation_id")
    finally:
        _CALLS.pop(call.call_id, None)


async def _hold(engine, driver, live_source, source, call: IncomingCall, entry: dict) -> Optional[str]:
    from flow_sdk.builtin.agent_serve import Turn, admits  # noqa: PLC0415
    from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415
    from flow_sdk.schema.types import EntityType  # noqa: PLC0415

    if not admits(source, call.caller):
        logger.info("[voice] call %s from an unlisted caller on %s refused", call.call_id, source.id)
        await live_source.reject(call)
        return None
    await ensure_identity(source, driver)
    session = await live_source.accept(call, instructions=voice_instructions(engine.agent, call))
    entry["session"] = session
    conversation = await record(driver, source, call, CallEvent(kind="said", text=call_started(call), item_id="start"))
    entry["conversation_id"] = conversation
    turn_session = str(TypeId(type=EntityType.CONVERSATION.value, id=conversation)) if conversation else f"call-{call.call_id}"
    #: The caller's sentence so far, per sentence: a partial carries only its newest words.
    speaking: dict[str, str] = {}
    asking: set = set()
    async for event in session.events():
        if event.kind in ("heard", "said"):
            speaking.pop(event.item_id, None)
            await record(driver, source, call, event)
        elif event.kind == "partial":
            speaking[event.item_id] = speaking.get(event.item_id, "") + event.text
            announce_partial(source, call, conversation, speaking[event.item_id])
        elif event.kind == "delegate":
            # Beside the stream, not in it: the caller keeps being heard while the agent works.
            turn = Turn(
                session=turn_session,
                key=f"{call.call_id}:{event.ask_id or next(_SEQ)}",
                body=turn_body(call, event.text),
                name=" · ".join(p for p in (engine.agent.name, source.channel or source.provider, call.caller) if p) or None,
            )
            asking.add(asyncio.get_running_loop().create_task(_delegate(engine, session, turn, event.ask_id)))
        elif event.kind == "ended":
            break
    if asking:
        await asyncio.gather(*asking, return_exceptions=True)
    await record(driver, source, call, CallEvent(kind="said", text=CALL_ENDED, item_id="end"))
    return conversation


async def _delegate(engine, session, turn, ask_id: str) -> None:
    """One request the voice handed the agent: its turn, and the answer handed back to be spoken."""
    try:
        outcome = await engine.run(turn)
        answer = outcome.text if outcome.ok and outcome.text else ""
    except Exception:  # noqa: BLE001 — the caller hears that it failed, not silence
        logger.exception("[voice] delegated turn %s failed", turn.key)
        answer = ""
    await session.resolve(ask_id, answer or "Sorry, I could not get an answer to that.")


async def record(driver, source, call: IncomingCall, event: CallEvent) -> Optional[str]:
    """One sentence as a message in the call's thread; answers the conversation id it was placed in."""
    from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415
    from flow_sdk.sources.values.event import DataSourceEvent, EventKind  # noqa: PLC0415
    from flow_sdk.stream_inbox.projection import project_source_item  # noqa: PLC0415

    item = sentence_item(source, driver, call, event)
    result = await driver.ingest_events(source, [DataSourceEvent(id=item.origin.key, kind=EventKind.UPSERT, origin=item.origin, item=item)])
    ids = [i for i in result.get("ids") or [] if i]
    row = await SourceItem.get_by_id(ids[0]) if ids else None
    if row is None:
        return None
    placed = await project_source_item(row, source=source)
    if placed is None:
        return None
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415

    fm = await FlowMessage.get_by_id(placed[0])
    return str(fm.conversation_id) if fm is not None and fm.conversation_id else None


def sentence_item(source, driver, call: IncomingCall, event: CallEvent):
    """A call sentence as the contract's item: the call's own thread, keyed by the call and the sentence."""
    from flow_sdk.sources.values.call import VoiceTurnData  # noqa: PLC0415
    from flow_sdk.sources.values.items import FileItem, MessageItem  # noqa: PLC0415
    from flow_sdk.sources.voice import person_profile, sentence_origin, thread_origin  # noqa: PLC0415

    kind = str(getattr(driver.cls, "origin_kind", "") or driver.provider)
    account = self_address(source, driver)
    ours = event.kind == "said"
    address = account if ours else call.caller
    name = str(getattr(source, "name", "") or "") if ours else (call.caller_name or call.caller)
    sentence = f"{call.call_id}:{event.item_id or f's{next(_SEQ)}'}"
    attachments = ()
    if event.audio is not None:
        attachments = (FileItem(origin=sentence_origin(kind, account, call.caller, f"{sentence}:audio"), data=event.audio),)
    return MessageItem(
        origin=sentence_origin(kind, account, call.caller, sentence),
        data=VoiceTurnData(
            text=event.text,
            call_id=call.call_id,
            conversation=thread_origin(kind, account, call.caller, call.call_id),
            sender=person_profile(kind, account, address, name),
            sent_at=datetime.now(timezone.utc),
            attachments=attachments,
        ),
    )


def self_address(source, driver) -> str:
    """The address this voice source answers at — its identity config value."""
    key = str(getattr(driver.cls, "identity_config_key", "") or "")
    return str((source.config or {}).get(key) or getattr(source, "account_key", "") or source.id).strip()


async def ensure_identity(source, driver) -> None:
    """The line's own address is one of the source's identities before its first sentence: the agent's
    sentences are signed with it, and must read as the agent's, never a stranger's."""
    from flow_sdk.stream_inbox.projection import is_self_address  # noqa: PLC0415

    address = self_address(source, driver)
    if address and not is_self_address(source, address):
        source.account_identities = [*(getattr(source, "account_identities", None) or []), address]
        if not getattr(source, "account_key", ""):
            source.account_key = address
        await source.save_runtime()


def announce_partial(source, call: IncomingCall, conversation: Optional[str], text: str) -> None:
    """The caller mid-sentence — a transient, never stored; the finished sentence arrives as a message."""
    from flow_sdk.tags import emit_tag, target_of  # noqa: PLC0415

    if not conversation:
        return
    emit_tag(
        "voice.call.partial",
        target_of("conversation", conversation),
        {"conversation_id": conversation, "call_id": call.call_id, "text": text[-500:]},
        ctx={"scope": [target_of("data_source", str(source.id))]},
    )


def _reset_for_tests() -> None:
    _CALLS.clear()


__all__ = [
    "CALL_ENDED",
    "call_started",
    "active_calls",
    "announce_partial",
    "answer_call",
    "answers_live",
    "hangup",
    "record",
    "ring",
    "sentence_item",
    "turn_body",
    "voice_instructions",
]
