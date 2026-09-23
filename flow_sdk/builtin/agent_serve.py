"""An agent's runtime on one placement: take a message, run the turn, answer.

Every way a message reaches an agent — a channel it owns (email, WhatsApp, a
help desk), its ``chat`` endpoint, a loop someone wrote over the block API — ends
in the same three steps, and this module is the one place they are written:

* **Which process.** One headless process per (placement, session) — a
  conversation, or a caller's own session key. Found by what it targets and
  the placement that spawned it, so it survives a restart, and spawned through
  the placement (``Deployment.create_process``) so the agent's worker, model,
  permissions and MCP servers are the ones ``agent.json`` declares.
* **One turn at a time.** Per session (``conversation_turn_lock``): a second
  message waits for the first answer instead of racing it.
* **At most one answer per message.** The turn is recorded on the process
  before it is prompted and its text after, so a redelivered message is
  answered from the record — never by a second turn.

A turn can be read two ways: :meth:`TurnEngine.run` answers with the reply once
the turn ends; :meth:`TurnEngine.run_stream` yields what the agent writes while
it writes it.

Where it runs: a running local deployment is its own process running :func:`serve`
(``builtin/agent_loop``); :class:`AgentServer`, in the app, only keeps those processes
running. A deployment's ``chat`` endpoint is one more channel of it (:func:`ensure_chat_channel`).
"""

from __future__ import annotations

import asyncio
import logging
import os
import weakref
from datetime import datetime, timezone
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Optional

from flow_sdk.builtin import deployment_process

logger = logging.getLogger(__name__)

# ── the turn record, on the process (durable, so a redelivery is answered from it) ──

TURNS = "turns"
STARTED, DONE = "started", "done"
#: On a STARTED record: the OS process running the turn. Another process (the app, reading the
#: row) tells a turn in flight from one abandoned by a dead loop by whether that pid is alive.
OWNER_PID = "pid"
#: Records kept per session. A redelivery is always of a RECENT message; older records are noise.
TURNS_KEPT = 200


def turns_of(ap) -> dict:
    data = getattr(ap, "context_data", None) or {}
    turns = data.get(TURNS) or {}
    return turns if isinstance(turns, dict) else {}


async def stamp_turn(ap, key: str, entry: dict) -> None:
    """Write one turn's record, bounded so a long-lived session cannot grow it forever."""
    turns = dict(turns_of(ap))
    turns[key] = entry
    if len(turns) > TURNS_KEPT:
        for stale in list(turns)[: len(turns) - TURNS_KEPT]:
            turns.pop(stale, None)
    await _write_turns(ap, turns)


def started_record() -> dict:
    """The record of a turn taking place now, in THIS OS process (see ``OWNER_PID``)."""
    return {"status": STARTED, OWNER_PID: os.getpid(), "at": datetime.now(timezone.utc).isoformat()}


async def _forget_turn(ap, key: str) -> None:
    """Drop one turn's record — a turn that was never taken has none."""
    turns = dict(turns_of(ap))
    if turns.pop(key, None) is not None:
        await _write_turns(ap, turns)


async def _write_turns(ap, turns: dict) -> None:
    """The ONE writer of a session's turn records."""
    data = dict(getattr(ap, "context_data", None) or {})
    data[TURNS] = turns
    ap.context_data = data
    await ap.save()


# ── what a turn is asked with, and what it answers with ──────────────────────


def turn_key(message) -> str:
    """One message, one key. The natural key (source + origin) when the message has one, else its own id."""
    source = getattr(message, "data_source_id", "") or ""
    external = str(getattr(message, "external_id", "") or "")
    if not source:
        return external
    parts = (
        getattr(message, "origin_kind", ""),
        getattr(message, "origin_namespace", ""),
        getattr(message, "origin_key", "") or external,
    )
    return ":".join([source, *(str(p or "") for p in parts)])


@dataclass(frozen=True)
class Turn:
    """One message for the agent.

    ``session`` names the conversation it continues (a process is reused per
    session); ``key`` names THIS message, so a redelivery is recognised.
    """

    session: str
    key: str
    body: str
    #: A label for a new process's run ("support-bot · whatsapp · Dana").
    name: Optional[str] = None
    #: Extra ``context_data`` stamped on a NEW process (a workflow, a session key).
    context: dict = field(default_factory=dict)


@dataclass(frozen=True)
class TurnEvent:
    """What a turn produced, as it is produced.

    ``text`` — a message the agent wrote (whole: a transcript records messages,
    not tokens). ``tool`` — it used a tool (``name``). ``done`` — the turn is
    over; ``text`` is the reply. ``refused`` — the turn was not taken
    (``text`` says why); nothing ran.
    """

    kind: str
    text: str = ""
    name: str = ""


# ── the engine ───────────────────────────────────────────────────────────────


class TurnEngine:
    """Runs an agent's turns on one placement (see the module docstring)."""

    def __init__(self, agent, deployment, *, workdir: Optional[str] = None):
        self.agent = agent
        self.deployment = deployment
        self.workdir = workdir

    async def find_process(self, session: str):
        """The session's process on this placement — the newest one not failed — or None."""
        from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415
        from flow_sdk.builtin.process_lifecycle import ProcessStatus  # noqa: PLC0415

        existing = await AgenticProcess.local_rows(
            {
                "match": {"target_typeid_str": session, "deployment_id": self.deployment.id},
                "order_by": {"created_date": "desc"},
            }
        )
        return next((p for p in existing if str(getattr(p, "status", "")) != ProcessStatus.FAILED.value), None)

    async def process_for(self, session: str, *, name: Optional[str] = None, context: Optional[dict] = None):
        """The session's process on this placement — :meth:`find_process`, else a new one."""
        if not self.workdir:
            self.workdir = await workdir_for(self.agent)
        workdir = self.workdir
        process = await self.find_process(session)
        if process is not None:
            if getattr(process, "shell_id", None):
                try:
                    await process.exit()
                except Exception:  # noqa: BLE001 — a stale shell does not break reuse
                    pass
            wanted = {"workdir": workdir, "visible": False, "pty_mode": False}
            if any(getattr(process, k) != v for k, v in wanted.items()):
                for k, v in wanted.items():
                    setattr(process, k, v)
                await process.save()
            return process
        options: dict[str, Any] = {"visible": False, "pty_mode": False}
        if context:
            options["context_data"] = dict(context)
        process = await self.deployment.create_process(
            "",
            # Created with no prompt, so without a name its run reads "<agent>: " —
            # nothing says whose session it answers. Reused per session, so this names that.
            name=name,
            target_typeid_str=session,
            workdir=workdir,
            **options,
        )
        await process.save()
        return process

    async def run(self, turn: Turn, *, process=None) -> TurnEvent:
        """The turn's outcome once it is over: ``done`` with the reply, or ``refused``.

        *process* runs the turn on a process the caller already routed (the block
        runner keeps its own per-session map); otherwise the session's process here.
        """
        last = TurnEvent("refused", "the turn produced nothing")
        async for event in self._turn(turn, process, stream=False):
            last = event
        return last

    async def run_stream(self, turn: Turn, *, process=None) -> AsyncIterator[TurnEvent]:
        """Run *turn*, yielding what the agent writes as it writes it; the last event is ``done`` or ``refused``."""
        async for event in self._turn(turn, process, stream=True):
            yield event

    async def _turn(self, turn: Turn, process, *, stream: bool) -> AsyncIterator[TurnEvent]:
        from flow_sdk.app.actions.execute_prompt import (  # noqa: PLC0415
            _capture_assistant_reply,
            _last_turn_assistant_text,
            conversation_turn_lock,
        )

        async with conversation_turn_lock(turn.session):
            ap = process or await self.process_for(turn.session, name=turn.name, context=turn.context)
            prior = turns_of(ap).get(turn.key)
            if prior and prior.get("status") == DONE:
                yield TurnEvent("done", prior.get("text", ""))
                return
            if prior and prior.get("status") == STARTED:
                # Died mid-turn. Did the agent finish? The transcript knows.
                text = await _capture_assistant_reply(ap)
                if text:
                    await stamp_turn(ap, turn.key, {"status": DONE, "text": text})
                    yield TurnEvent("done", text)
                    return
            start = len(transcript_entries(ap)) if stream else 0
            await stamp_turn(ap, turn.key, started_record())
            taken = await ap.send_turn(turn.body)
            if not taken.ok:
                # Nothing ran, so nothing is recorded: a STARTED stamp left behind would
                # make the redelivery read the transcript's latest reply — another turn's.
                await _forget_turn(ap, turn.key)
                yield TurnEvent("refused", taken.detail or "the turn was not taken")
                return
            if stream:
                async for event in _follow(ap, start):
                    yield event
                text = _last_turn_assistant_text(transcript_entries(ap)[start:]) or await _capture_assistant_reply(ap)
            else:
                text = await _capture_assistant_reply(ap)
            await stamp_turn(ap, turn.key, {"status": DONE, "text": text or ""})
            yield TurnEvent("done", text or "")


def transcript_entries(ap) -> list:
    """The process's transcript as typed entries, or ``[]`` before it has one."""
    from flow_sdk.transcript_analyzer import AgentTranscriptFile  # noqa: PLC0415

    try:
        desc = ap.driver.transcript_descriptor(ap)
    except Exception:  # noqa: BLE001 — a driver that cannot say yet has no transcript yet
        desc = None
    path = desc.path if desc is not None else ap.driver.transcript_path(ap)
    if path is None or not path.exists():
        return []
    try:
        transcript = AgentTranscriptFile(
            ap.driver.name,
            path,
            session_id=ap.session_id or "",
            transcript_format=desc.format if desc is not None else None,
        )
        return list(transcript.entries)
    except Exception:  # noqa: BLE001 — a half-written file reads as "nothing new yet"
        logger.debug("agent turn: transcript parse failed for %s", path, exc_info=True)
        return []


async def _follow(ap, start: int) -> AsyncIterator[TurnEvent]:
    """Yield the turn's entries after *start* as they land; end when the turn does.

    The end is ``stream_transcript``'s — the same signal ``_capture_assistant_reply``
    trusts (resume-aware: a prior turn's terminal marker does not end this one).
    It runs beside a re-read of the transcript on each new line, so what the agent
    writes is seen while it writes it.
    """
    seen = start
    lines = ap.stream_transcript().__aiter__()
    finished = False
    while not finished:
        try:
            await lines.__anext__()
        except StopAsyncIteration:
            finished = True
        entries = transcript_entries(ap)
        for entry in entries[seen:]:
            event = _event_of(entry)
            if event is not None:
                yield event
        seen = max(seen, len(entries))
        await asyncio.sleep(0)


# The entries that are something the agent DID — everything else a transcript
# records (meta, token usage, summaries, system lines) is bookkeeping, not news.
_OPERATIONS = frozenset(
    {
        "tool_use",
        "file_write",
        "file_edit",
        "file_read",
        "shell_command",
        "flow_command",
        "skill_call",
        "artifact",
        "search",
        "web_fetch",
        "todo_update",
        "agent_spawn",
    }
)


def _event_of(entry) -> Optional[TurnEvent]:
    kind = getattr(getattr(entry, "kind", None), "value", getattr(entry, "kind", ""))
    if kind == "assistant_message":
        text = str(getattr(entry, "text", "") or "").strip()
        return TurnEvent("text", text) if text else None
    if kind in _OPERATIONS:
        return TurnEvent("tool", name=str(getattr(entry, "tool_name", "") or kind))
    return None


async def workdir_for(agent) -> str:
    """Where a turn runs: the agent's project, else the instance data dir.

    A turn needs somewhere to be; it does not need somewhere specific. Falling
    back rather than refusing keeps a project-less agent answerable.
    """
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    project = await Project.get_by_id(agent.project_id) if getattr(agent, "project_id", None) else None
    mount = str(getattr(project, "fs_storage_mount_path", "") or "") if project else ""
    return mount or str(get_instance_settings().instance_dir)


# ── who may drive the agent through a source ─────────────────────────────────


def admits(source, author: str) -> bool:
    """Whether *author* may drive the agent through *source*.

    Answered from the SOURCE alone — its status and its cached allowlist. The
    allowlist is the rule (``sender_allowed``, the one fold). ``open_inbound`` is a
    driver's declaration that strangers are the point of its channel (a help desk,
    a chat endpoint), under which an EMPTY list admits everyone; a non-empty list
    restricts either way, and a paused source admits nobody either way.
    """
    from flow_sdk.builtin.agent_mailbox import sender_allowed  # noqa: PLC0415
    from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415
    from flow_sdk.builtin.data_source import SourceStatus  # noqa: PLC0415

    if getattr(source, "status", None) != SourceStatus.ACTIVE.value:
        return False
    allowlist = [a for a in (getattr(source, "inbound_allowed_senders", None) or []) if str(a).strip()]
    if sender_allowed(allowlist, author):
        return True
    driver = DataDriver.loaded(getattr(source, "provider", "") or "")
    return bool(driver is not None and driver.open_inbound and not allowlist)


def is_own_outgoing(source, author: str) -> bool:
    """Did WE write this? The loop guard: an agent must never answer itself."""
    from flow_sdk.stream_inbox.projection import is_self_address  # noqa: PLC0415

    return is_self_address(source, author or "")


# ── where a source is answered ──────────────────────────────────────────────


async def answers_here(source, deployment) -> bool:
    """Whether *deployment* (a placement on this machine) is the one answering *source*.

    ``answer_place`` names it. A mailbox still follows the agent's ``email_place``
    until it carries its own; a source that names no place is answered wherever it
    is held, as before places existed.
    """
    place = str(getattr(source, "answer_place", "") or "")
    if place:
        return place == str(deployment.id)
    if str(getattr(source, "provider", "") or "") == "cloud_email":
        from flow_sdk.builtin.agent_places import email_answers_here  # noqa: PLC0415

        return await email_answers_here(str(getattr(deployment, "parent_type_id", "")).partition("-")[2])
    # Several local deployments of one agent answer only what names them; the rest is the default one's.
    return not str(getattr(deployment, "slot", "") or "")


# ── the chat endpoint: an HTTP message channel per deployment ────────────────

CHAT = "chat"
_CHAT_LOCKS: dict[str, asyncio.Lock] = {}


async def _made_chat_source(driver, agent, deployment):
    """The deployment's chat channel, made now — or the one another process made a moment ago.

    The lock above is this process's; the app's supervisor and a script launching the deployment
    are two processes, and the loser of that race finds the winner's row on its second look."""
    from flow_sdk.assets.creation import AssetPathCollisionError  # noqa: PLC0415
    from flow_sdk.builtin.data_source import DataSource, SourceStatus  # noqa: PLC0415

    key = driver.cls.identity_config_key
    source = driver.create_source(
        driver.create_config(**{key: str(deployment.id)}),
        name=f"{agent.name or agent.id} chat" + (f" {deployment.slot}" if getattr(deployment, "slot", "") else ""),
        owner=agent.typeid,
        answer_place=str(deployment.id),
        account_key=f"deployment:{deployment.id}",
        status=SourceStatus.ACTIVE.value,
    )
    try:
        await source.save()
        return source
    except AssetPathCollisionError:
        made = await DataSource.find_for_account(driver.provider, key, str(deployment.id))
        if made is None:
            raise
        return made


def deployment_chat_driver():
    """The driver that carries a deployment's HTTP chat, or ``None`` — found by what it can do
    (turn an HTTP request into a message, and its reply back into a response), never by name."""
    from flow_sdk.ingest.driver_runtime import DRIVERS  # noqa: PLC0415

    return next((d for _key, d in DRIVERS.items() if is_request_channel(d.cls)), None)


def is_request_channel(cls) -> bool:
    """A driver class an HTTP request can be a message on (``events_from_request`` / ``reply_payload``)."""
    return all(callable(getattr(cls, verb, None)) for verb in ("events_from_request", "reply_payload", "request_thread"))


async def ensure_chat_channel(agent, deployment):
    """The deployment's ``chat`` endpoint (``api.chat.openai``) and the message channel behind it.

    ``ServiceEndpoint (HTTP) → the channel (a DataSource the agent owns, answered by THIS
    deployment) → the deployment's loop → the reply``. Idempotent: looked up by the deployment.
    The lock stops two callers in THIS process minting two; another process racing it is met by
    :func:`_made_chat_source`.
    """
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
    from flow_sdk.builtin.service_endpoint import ServiceEndpoint  # noqa: PLC0415
    from flow_sdk.builtin.webapp_placement import upsert_endpoint  # noqa: PLC0415
    from flow_sdk.schema.data_spec.service_endpoint_spec import PROTOCOL_API_CHAT_OPENAI  # noqa: PLC0415

    driver = deployment_chat_driver()
    if driver is None:
        raise RuntimeError("no data driver can carry a deployment's chat (events_from_request)")
    key = driver.cls.identity_config_key
    async with _CHAT_LOCKS.setdefault(str(deployment.id), asyncio.Lock()):
        source = await DataSource.find_for_account(driver.provider, key, str(deployment.id))
        if source is None:
            source = await _made_chat_source(driver, agent, deployment)
        existing = await ServiceEndpoint.find_existing(str(deployment.typeid), CHAT)
        row, _saved = await upsert_endpoint(
            deployment,
            name=CHAT,
            protocol={"spec_kind": PROTOCOL_API_CHAT_OPENAI},
            backend={"type": "channel", "data_source_id": str(source.id)},
            project_id=getattr(deployment, "project_id", None) or getattr(agent, "project_id", None),
            existing=existing,
        )
    return row


# ── the serve loop: every channel the agent answers here ─────────────────────


async def answered_sources(agent, deployment) -> list:
    """The agent's message sources that *deployment* answers."""
    from flow_sdk.builtin.agent_calls import answers_live  # noqa: PLC0415

    # A channel people talk to live is answered by the call (``agent_calls``), never by the drain.
    return [s for s in await agent.channels() if not answers_live(s) and await answers_here(s, deployment)]


async def running_deployments() -> list:
    """The local agent deployments that run here now: ``serving``, and their process alive."""
    from flow_sdk.builtin.deployment import KIND_AGENT, Deployment  # noqa: PLC0415
    from flow_sdk.worldview.ontology import kind_matches  # noqa: PLC0415

    rows = await Deployment.get_all({"match": {"kind": KIND_AGENT}})
    return [d for d in rows if d.serving and kind_matches(KIND_AGENT, d.kind) and d.is_local and deployment_process.alive(d)]


async def polled_by_a_deployment(sources=None) -> set[str]:
    """The ids of the sources a running deployment's process polls itself — so this app must not.

    A deployment's loop polls the channels it answers (:func:`answered_sources`) from its own
    process; the app's heartbeat polling the same source at the same moment would race its cursor
    (the in-flight guard is per process). A dead deployment's channels are polled here as ever.
    *sources* narrows the answer to those.
    """
    held: set[str] = set()
    for deployment in await running_deployments():
        agent = await deployment.agent()
        if agent is not None:
            held.update(str(s.id) for s in await answered_sources(agent, deployment))
    return held if sources is None else held & {str(s.id) for s in sources}


def consumer_of(deployment) -> str:
    """The durable consumer a placement's serve loop drains as — its position per source."""
    return f"agent-serve:{deployment.id}"


async def hold_positions(deployment, sources) -> None:
    """The deployment's position on each source, made now if it is new.

    A loop yields ARRIVALS — what a source held before it was answered here is history. "Before"
    is the later of the deployment's and the source's creation: a channel bound to a running
    deployment is answered from when it was bound, not from when its loop first noticed it (the
    messages in between are arrivals, and would otherwise be swallowed as history).
    """
    from flow_sdk.builtin import ingest_order  # noqa: PLC0415
    from flow_sdk.builtin.consumer_position import ConsumerPosition  # noqa: PLC0415
    from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415

    for source in sources:
        since = max(filter(None, (deployment.created_date, source.created_date)), key=ingest_order.bind, default=None)
        baseline = await SourceItem.newest_for(str(source.id), at_or_before=since)
        await ConsumerPosition.ensure_for(consumer_of(deployment), str(source.id), baseline=baseline)


async def serve(agent, deployment, *, sources=None, poll_every: "float | None" = None) -> None:
    """Answer every message on the agent's channels that answer on *deployment*, until cancelled.

    One durable drain (a named consumer per placement, so a restart resumes after
    the last answer) over all of them; each message passes the loop guard and the
    source's gate, runs through the turn engine in its conversation, and is
    replied to on its own channel (send → record → ack). *sources* defaults to
    :func:`answered_sources`; ``poll_every`` is the drain's cadence (the driver's
    own, else 3 s).
    """
    from flow_sdk.blocks import StreamInbox, workflow  # noqa: PLC0415
    from flow_sdk.blocks.arrivals import stoppable  # noqa: PLC0415
    from flow_sdk.blocks.merge import pages  # noqa: PLC0415

    sources = list(sources) if sources is not None else await answered_sources(agent, deployment)
    if not sources:
        return
    by_id = {str(s.id): s for s in sources}
    engine = TurnEngine(agent, deployment)
    stop = asyncio.Event()
    task = asyncio.current_task()
    if task is not None:
        _STOPS[task] = stop
    with stoppable(stop):
        async with workflow(consumer_of(deployment)):
            async for page in pages(*(StreamInbox.of(s) for s in sources), poll_every=poll_every):
                if stop.is_set():
                    continue  # unacked: the next loop on this placement is handed it again
                source = by_id[page.source_id]
                for message in page:
                    await answer(engine, message, source=source)
                await page.ack()


async def answer(engine: TurnEngine, message, *, source=None, session: Optional[str] = None, process=None) -> bool:
    """One channel message: gate it, run it in its conversation, reply on its channel.

    Answers whether a reply went out. Every refusal — our own outgoing copy, a
    sender the source does not admit, an empty body, a turn that produced
    nothing — is an ordinary outcome, not an error: the message is already
    ingested and projected, so its owner sees it either way.

    The routing is the caller's to override, the gates are not: *session* names the
    session to answer in (one process per session on the engine's placement, found
    again after a restart) instead of the message's conversation, and *process* runs
    the turn on a process the caller already holds. *source* is the message's own
    when not given. A message that is gated out, or whose reply the source sends by
    itself, is acked here — a per-message loop would otherwise be handed it again;
    a turn the process refused is not, so it is.
    """
    if source is None:
        source = await message._source()
    from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415
    from flow_sdk.schema.types import EntityType  # noqa: PLC0415
    from flow_sdk.stream_inbox.projection import display_name_of  # noqa: PLC0415

    agent = engine.agent
    author = str(getattr(message, "author_external_id", "") or "")
    body = str(getattr(message, "body", "") or "").strip()
    # The loop guard first: pure string work, and every reply the agent sends comes back.
    if is_own_outgoing(source, author):
        return await _skip(message)
    if not admits(source, author):
        logger.info("agent %s: not answering an unlisted sender on %s", agent.name or agent.id, source.id)
        return await _skip(message)
    if not body:
        return await _skip(message)
    # Three facts a source may declare about its messages (the driver class says; nothing here names one):
    # a ``quiet`` message is the log, not a call to act; ``turn_session`` names the session a message is
    # answered in; ``replies_explicitly`` means the turn's text is not sent back by itself.
    driver_cls = _driver_cls(source)
    if getattr(getattr(message, "data", None), "quiet", False):
        return await _skip(message)
    session = str(session or "")
    hook = getattr(driver_cls, "turn_session", None)
    if not session and callable(hook):
        session = str(hook(message) or "")
    if not session:
        conversation = await conversation_of(message, source)
        if not conversation:
            logger.warning("agent %s: message on %s has no conversation yet", agent.name or agent.id, source.id)
            return False
        session = str(TypeId(type=EntityType.CONVERSATION.value, id=conversation))
    who = display_name_of(getattr(message, "author_display", "") or "", author)
    outcome = await engine.run(
        Turn(
            session=session,
            key=turn_key(message),
            body=body,
            name=" · ".join(p for p in (agent.name, source.channel or source.provider, who) if p) or None,
        ),
        process=process,
    )
    if outcome.kind != "done" or not outcome.text:
        logger.info("agent %s: no reply to %s (%s)", agent.name or agent.id, session, outcome.text or outcome.kind)
        return False
    if getattr(driver_cls, "replies_explicitly", False):
        await _skip(message)
        return True
    await message.reply(await message.reply_spec(body=outcome.text))
    return True


async def _skip(message) -> bool:
    """Settle a message that gets no reply from here — acked when it came from a listener."""
    ack = getattr(message, "ack", None)
    if callable(ack):
        await ack()
    return False


def _driver_cls(source):
    from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415

    driver = DataDriver.loaded(str(getattr(source, "provider", "") or ""))
    return driver.cls if driver is not None else None


async def conversation_of(message, source) -> Optional[str]:
    """The conversation the message was placed in, or None when it has not been placed.

    READ from the thread the way the projection wrote it (``find_thread``), never
    re-derived: once a thread exists its ``conversation_id`` is authoritative,
    because merging two threads repoints it — a derivation would answer with the
    pre-merge id and split the session. No thread means no answer: a fabricated
    conversation would pin a process nothing else can find.
    """
    from flow_sdk.stream_inbox.projection import channel_of, find_thread, owner_of, thread_key_for  # noqa: PLC0415

    row = getattr(message, "_row", None) or message
    thread = await find_thread(
        channel_of(source), thread_key_for(row, getattr(row, "name", "") or ""), await owner_of(source), str(source.id)
    )
    return str(getattr(thread, "conversation_id", "") or "") or None


# ── what a loop serves, and the supervisor of the processes that run loops ──


def serving_key(source) -> tuple:
    """What a loop's copy of *source* must still say for the loop to keep serving it.

    A poll's runtime write (a cursor, a next-poll time) is not news; a new owner,
    place, status or allowlist is — the loop holds its rows, so it restarts on them.
    """
    return (
        str(source.id),
        str(getattr(source, "owner", "") or ""),
        str(getattr(source, "channel", "") or ""),
        str(getattr(source, "provider", "") or ""),
        str(getattr(source, "answer_place", "") or ""),
        str(getattr(source, "status", "") or ""),
        tuple(sorted(str(a) for a in (getattr(source, "inbound_allowed_senders", None) or []))),
    )


class AgentServer:
    """Keeps every running local agent deployment's PROCESS running.

    A running local deployment is a subprocess running the agent loop (``builtin/agent_loop``);
    this app only starts it, adopts it alive after a restart, starts it again when it died, and
    stops it when the deployment stops serving, its agent is switched off there, or it is deleted
    (``builtin/deployment_process``). Reconciled at start, on every ``agent``/``deployment`` write
    (``entity.*`` tags), and every ``watch_seconds`` — for what no tag here reports: a process that
    died, a deployment another process wrote. A Chief of Staff's Tasks channel is synced on writes.
    """

    def __init__(self, *, run_processes: bool = True, watch_seconds: float = 10.0):
        #: Off in the test tier: chat channels are still made, no process is started or stopped.
        self.run_processes = run_processes
        self.watch_seconds = watch_seconds
        self._stopped = False
        #: deployment id → the deployment, for the processes this server started or adopted
        self._running: dict[str, Any] = {}
        #: A write happened that is not reconciled yet (the watch alone does not set it).
        self._dirty = False
        self._pending: Any = None
        self._watch: Any = None
        self._unsubscribe: Any = None
        self._reconciling = asyncio.Lock()

    async def start(self) -> None:
        """Arm, and reconcile in the background — startup does not wait on it."""
        from flow_sdk.request_context.detached import create_detached_task  # noqa: PLC0415
        from flow_sdk.tags import on_tag  # noqa: PLC0415

        self._unsubscribe = on_tag("entity.*", self._on_entity)
        self._touch()
        self._watch = create_detached_task(self._watching(), name="agent-server-watch")

    async def stop(self) -> None:
        """Stop reconciling. The processes keep running — they outlive the app, and the next start
        adopts them; stopping one is the deployment's own ``pause``."""
        if self._unsubscribe is not None:
            self._unsubscribe()
        self._stopped = True
        for task in (self._watch, self._pending):
            if task is not None and not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    def running(self) -> set[str]:
        """The ids of the deployments whose process this server keeps."""
        return set(self._running)

    async def _watching(self) -> None:
        while not self._stopped:
            await asyncio.sleep(self.watch_seconds)
            if self._pending is None or self._pending.done():
                try:
                    await self.reconcile(chiefs=False)
                except Exception:  # noqa: BLE001 — the next tick looks again
                    logger.exception("agent server: watch failed")

    async def _on_entity(self, event) -> None:
        if str((event.data or {}).get("entity_type") or "") in ("agent", "deployment"):
            self._touch()

    def _touch(self) -> None:
        from flow_sdk.request_context.detached import create_detached_task  # noqa: PLC0415

        if self._stopped:
            return
        self._dirty = True
        if self._pending is None or self._pending.done():
            # Detached: a tag fires inside the writer's commit, whose session this must not join.
            self._pending = create_detached_task(self._drain(), name="agent-server-reconcile")

    async def _drain(self) -> None:
        """Reconcile until no write is left unreconciled — one that lands mid-reconcile runs it again."""
        while self._dirty and not self._stopped:
            self._dirty = False
            try:
                await self.reconcile()
            except Exception:  # noqa: BLE001 — the next write (or the watch) reconciles again
                logger.exception("agent server: reconcile failed")

    async def reconcile(self, *, chiefs: bool = True) -> None:
        async with self._reconciling:
            if chiefs:
                await self._sync_chiefs_of_staff()
            wanted, strays = await self._wanted()
            if not self.run_processes:
                for agent, deployment in wanted.values():
                    await ensure_chat_channel(agent, deployment)
                return
            strays += [self._running.pop(d) for d in list(self._running) if d not in wanted]
            await asyncio.gather(*(self._stop_process(d) for d in strays))
            for deployment_id, (agent, deployment) in wanted.items():
                if self._stopped:
                    return
                try:
                    await self._keep_running(agent, deployment)
                except Exception:  # noqa: BLE001 — one deployment must not stop the others
                    logger.exception("agent %s: deployment %s did not start", agent.id, deployment.id)

    async def _wanted(self) -> tuple[dict[str, tuple], list]:
        """``(wanted, strays)``: every running local agent deployment whose agent is enabled there,
        and every local one whose process is alive though it should not be (stopped serving, or its
        agent switched off, while this server did not hold it — a restart)."""
        from flow_sdk.builtin.deployment import KIND_AGENT, Deployment  # noqa: PLC0415
        from flow_sdk.worldview.ontology import kind_matches  # noqa: PLC0415

        wanted: dict[str, tuple] = {}
        strays: list = []
        for deployment in await Deployment.get_all({"match": {"kind": KIND_AGENT}}):
            if not kind_matches(KIND_AGENT, deployment.kind) or not deployment.is_local:
                continue
            agent = await deployment.agent() if deployment.serving else None
            if agent is not None and agent.enabled_on(deployment.id):
                wanted[str(deployment.id)] = (agent, deployment)
            elif str(deployment.id) not in self._running and deployment_process.alive(deployment):
                strays.append(deployment)
        return wanted, strays

    async def _keep_running(self, agent, deployment) -> None:
        if str(deployment.id) in self._running and deployment_process.alive(deployment):
            return
        await ensure_chat_channel(agent, deployment)
        if not deployment_process.alive(deployment):
            deployment.provider_labels = {**(deployment.provider_labels or {}), **deployment_process.start(deployment)}
            await deployment.save()
            logger.info("agent %s: deployment %s runs as pid %s", agent.name or agent.id, deployment.id,
                        deployment_process.recorded(deployment).pid)
        self._running[str(deployment.id)] = deployment   # started now, or alive from before a restart: adopted

    async def _stop_process(self, deployment) -> None:
        from flow_sdk.builtin.deployment import Deployment  # noqa: PLC0415

        if not await asyncio.to_thread(deployment_process.stop, deployment):
            logger.warning("deployment %s: its process did not stop", deployment.id)
            return
        fresh = await Deployment.get_by_id(str(deployment.id))
        if fresh is not None:
            fresh.provider_labels = {**(fresh.provider_labels or {}), **deployment_process.labels_of(None)}
            await fresh.save()

    async def _sync_chiefs_of_staff(self) -> None:
        """A Chief of Staff's Tasks channel follows its checkbox — bound here, so its serve loop picks
        it up; an active one whose agent is no longer a chief is paused. Read from the rows, not
        remembered, so a checkbox turned off while this machine was down is honoured too."""
        from flow_sdk.builtin.agent import Agent  # noqa: PLC0415
        from flow_sdk.builtin.data_source import DataSource, SourceStatus  # noqa: PLC0415
        from flow_sdk.db.drivers.query import QueryFilter  # noqa: PLC0415
        from flow_sdk.ingest.bus_sources import principal_channel_for  # noqa: PLC0415
        from flow_sdk.schema.types import EntityType  # noqa: PLC0415
        from flow_sdk.tasks.cos import sync_tasks_channel  # noqa: PLC0415
        from flow_sdk.tasks.identity import ref_kind  # noqa: PLC0415

        agents = {str(a.id): a for a in await Agent.get_all(QueryFilter.by_type(EntityType.AGENT.value)) or []}
        wanted = {aid for aid, a in agents.items() if getattr(a, "chief_of_staff", False)}
        runtime = principal_channel_for("task.created")
        if runtime is not None:
            key = runtime.cls.identity_config_key
            for row in await DataSource.get_all({"provider": runtime.provider}) or []:
                kind, aid = ref_kind(str((row.config or {}).get(key) or ""))
                if kind == "agent" and aid in agents and aid not in wanted and row.status == SourceStatus.ACTIVE.value:
                    wanted.add(aid)  # to be paused
        for aid in wanted:
            try:
                await sync_tasks_channel(agents[aid])
            except Exception:  # noqa: BLE001 — one agent's channel must not stop the rest
                logger.exception("agent %s: tasks channel sync failed", aid)

#: Each running :func:`serve` loop's stop — how :func:`stop_serving` asks it to end.
_STOPS: "weakref.WeakKeyDictionary[asyncio.Task, asyncio.Event]" = weakref.WeakKeyDictionary()


async def stop_serving(loop) -> None:
    """End a :func:`serve` loop between cycles — never mid-poll, mid-page or mid-turn, where a
    cancel cuts a database write in half (the turn's reply unsent, a session rolled back mid-close).
    A turn in progress finishes first; pages not yet answered stay unacked for the next loop."""
    stop = _STOPS.get(loop)
    if stop is None:
        loop.cancel()
    else:
        stop.set()
    await asyncio.gather(loop, return_exceptions=True)


__all__ = [
    "AgentServer",
    "answer",
    "answered_sources",
    "CHAT",
    "Turn",
    "TurnEngine",
    "TurnEvent",
    "admits",
    "consumer_of",
    "conversation_of",
    "answers_here",
    "deployment_chat_driver",
    "ensure_chat_channel",
    "hold_positions",
    "is_own_outgoing",
    "is_request_channel",
    "polled_by_a_deployment",
    "running_deployments",
    "serve",
    "serving_key",
    "stamp_turn",
    "stop_serving",
    "transcript_entries",
    "turn_key",
    "turns_of",
    "workdir_for",
]
