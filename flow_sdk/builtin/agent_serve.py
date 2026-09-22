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
it writes it (a chat caller watches the answer form).
"""

from __future__ import annotations

import asyncio
import logging
import weakref
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Optional

logger = logging.getLogger(__name__)

# ── the turn record, on the process (durable, so a redelivery is answered from it) ──

TURNS = "turns"
STARTED, DONE = "started", "done"
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
            await stamp_turn(ap, turn.key, {"status": STARTED})
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
    return True


# ── the chat endpoint every agent placement has ─────────────────────────────

CHAT = "chat"
#: Per event loop, per placement (``stream_inbox/_locks``): a lock bound to a dead loop never blocks a new one.
_CHAT_LOCKS: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()


async def ensure_chat_endpoint(agent, deployment):
    """The placement's ``chat`` endpoint (``api.chat.openai``, answered by this app). Idempotent."""
    from flow_sdk.builtin.service_endpoint import ServiceEndpoint  # noqa: PLC0415
    from flow_sdk.builtin.webapp_placement import upsert_endpoint  # noqa: PLC0415
    from flow_sdk.schema.data_spec.service_endpoint_spec import PROTOCOL_API_CHAT_OPENAI  # noqa: PLC0415
    from flow_sdk.stream_inbox._locks import keyed_loop_lock  # noqa: PLC0415

    # Looked up and written under one lock: the supervisor and a box's expose-endpoints
    # both ensure it, and two lookups that each miss would mint two `chat` rows.
    async with keyed_loop_lock(_CHAT_LOCKS, str(deployment.id)):
        existing = await ServiceEndpoint.find_existing(str(deployment.typeid), CHAT)
        row, _saved = await upsert_endpoint(
            deployment,
            name=CHAT,
            protocol={"spec_kind": PROTOCOL_API_CHAT_OPENAI},
            backend={"type": "agent", "agent_id": agent.id},
            project_id=getattr(deployment, "project_id", None) or getattr(agent, "project_id", None),
            existing=existing,
        )
    return row


# ── the serve loop: every channel the agent answers here ─────────────────────


async def answered_sources(agent, deployment) -> list:
    """The agent's message sources that *deployment* answers."""
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
    from flow_sdk.stream_inbox.agent_scope import is_message_source  # noqa: PLC0415

    return [
        s
        for s in await DataSource.find_owned(agent.typeid)
        if is_message_source(s) and await answers_here(s, deployment)
    ]


def consumer_of(deployment) -> str:
    """The durable consumer a placement's serve loop drains as — its position per source."""
    return f"agent-serve:{deployment.id}"


async def hold_positions(deployment, sources) -> None:
    """The placement's position on each source, made now if it is new.

    A loop yields ARRIVALS — what a source held when its position was made is
    history. Made before the loop starts, so "serving" means a message landing
    from here on is answered, not "once the loop's first cycle has run".
    """
    from flow_sdk.builtin.consumer_position import ConsumerPosition  # noqa: PLC0415
    from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415

    for source in sources:
        newest = await SourceItem.newest_for(str(source.id))
        await ConsumerPosition.ensure_for(consumer_of(deployment), str(source.id), baseline=newest)


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
    from flow_sdk.blocks.merge import pages  # noqa: PLC0415

    sources = list(sources) if sources is not None else await answered_sources(agent, deployment)
    if not sources:
        return
    by_id = {str(s.id): s for s in sources}
    engine = TurnEngine(agent, deployment)
    async with workflow(consumer_of(deployment)):
        async for page in pages(*(StreamInbox.of(s) for s in sources), poll_every=poll_every):
            source = by_id[page.source_id]
            for message in page:
                await answer(engine, source, message)
            await page.ack()


async def answer(engine: TurnEngine, source, message) -> bool:
    """One channel message: gate it, run it in its conversation, reply on its channel.

    Answers whether a reply went out. Every refusal — our own outgoing copy, a
    sender the source does not admit, an empty body, a turn that produced
    nothing — is an ordinary outcome, not an error: the message is already
    ingested and projected, so its owner sees it either way.
    """
    from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415
    from flow_sdk.schema.types import EntityType  # noqa: PLC0415
    from flow_sdk.stream_inbox.projection import display_name_of  # noqa: PLC0415

    agent = engine.agent
    author = str(getattr(message, "author_external_id", "") or "")
    body = str(getattr(message, "body", "") or "").strip()
    # The loop guard first: pure string work, and every reply the agent sends comes back.
    if is_own_outgoing(source, author):
        return False
    if not admits(source, author):
        logger.info("agent %s: not answering an unlisted sender on %s", agent.name or agent.id, source.id)
        return False
    if not body:
        return False
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
        )
    )
    if outcome.kind != "done" or not outcome.text:
        logger.info("agent %s: no reply to %s (%s)", agent.name or agent.id, session, outcome.text or outcome.kind)
        return False
    await message.reply(await message.reply_spec(body=outcome.text))
    return True


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


# ── the supervisor: one loop per agent placement on this machine ────────────


def _serving_key(source) -> tuple:
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
    """Keeps every agent placement on this machine serving.

    For each local ``runtime.agent`` Deployment whose agent is enabled there: its
    ``chat`` endpoint exists, and (when ``serve_channels``) one :func:`serve` loop
    runs over the sources that placement answers. An agent that owns a channel has
    a placement here. Reconciled at start and whenever an agent, a placement or a
    source changes (``entity.*`` tags) — a source only when what serving depends on
    changed, so a poll's own runtime write never sets it off. A loop whose placement
    went away is ended; one whose sources changed is restarted over them.
    """

    def __init__(self, *, serve_channels: bool):
        self.serve_channels = serve_channels
        #: placement id → (the serving keys of the sources its loop serves, the loop)
        self._loops: dict[str, tuple[frozenset, Any]] = {}
        #: source id → its serving key as last seen
        self._seen: dict[str, tuple] = {}
        #: (entity type, id) of the writes not yet reconciled
        self._touched: set[tuple[str, str]] = set()
        self._pending: Any = None
        self._unsubscribe: Any = None
        self._reconciling = asyncio.Lock()

    async def start(self) -> None:
        """Arm, and reconcile in the background — startup does not wait on it."""
        from flow_sdk.tags import on_tag  # noqa: PLC0415

        self._unsubscribe = on_tag("entity.*", self._on_entity)
        self._touch("start", "")

    async def stop(self) -> None:
        if self._unsubscribe is not None:
            self._unsubscribe()
        for _keys, loop in self._loops.values():
            await _ended(loop)
        self._loops.clear()

    def serving(self) -> dict[str, frozenset]:
        """Placement id → the ids of the sources its live loop serves."""
        return {key: frozenset(k[0] for k in keys) for key, (keys, loop) in self._loops.items() if not loop.done()}

    async def _on_entity(self, event) -> None:
        data = event.data or {}
        kind = str(data.get("entity_type") or "")
        if kind in ("agent", "deployment", "data_source"):
            self._touch(kind, str(data.get("id") or ""))

    def _touch(self, kind: str, entity_id: str) -> None:
        from flow_sdk.request_context.detached import create_detached_task  # noqa: PLC0415

        self._touched.add((kind, entity_id))
        if self._pending is None or self._pending.done():
            # Detached: a tag fires inside the writer's commit, whose session this must not join.
            self._pending = create_detached_task(self._drain(), name="agent-server-reconcile")

    async def _drain(self) -> None:
        """Reconcile until no write is left unreconciled — one that lands mid-reconcile runs it again."""
        while self._touched:
            touched, self._touched = self._touched, set()
            if all(kind == "data_source" for kind, _ in touched) and not await self._sources_changed(touched):
                continue
            try:
                await self.reconcile()
            except Exception:  # noqa: BLE001 — the next write reconciles again
                logger.exception("agent server: reconcile failed")

    async def _sources_changed(self, touched) -> bool:
        from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415

        for _kind, source_id in touched:
            source = await DataSource.get_by_id(source_id) if source_id else None
            if self._seen.get(source_id) != (_serving_key(source) if source is not None else None):
                return True
        return False

    async def reconcile(self) -> None:
        async with self._reconciling:
            owned = await self._channels_by_agent()
            wanted = await self._placements(owned)
            if self.serve_channels:
                await self._converge(wanted, owned)

    async def _channels_by_agent(self) -> dict[str, list]:
        """Agent id → the message sources it owns. One read of the sources on a channel."""
        from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
        from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415
        from flow_sdk.schema.types import EntityType  # noqa: PLC0415
        from flow_sdk.stream_inbox.agent_scope import is_message_source  # noqa: PLC0415
        from flow_sdk.stream_inbox.projection import owner_of  # noqa: PLC0415

        on_a_channel = QueryFilter(match=ExpressionNode(op=QueryOp.IS_NOT_NULL, operands=["channel"]))
        owned: dict[str, list] = {}
        for source in await DataSource.get_all(on_a_channel):
            self._seen[str(source.id)] = _serving_key(source)
            if not is_message_source(source):
                continue
            owner = await owner_of(source)
            if owner is not None and owner.type == EntityType.AGENT.value:
                owned.setdefault(owner.id, []).append(source)
        return owned

    async def _placements(self, owned: dict[str, list]) -> dict[str, tuple]:
        """Every local agent placement whose agent is enabled there — each with its ``chat`` endpoint.

        An agent that owns a channel answers it from this machine unless told otherwise,
        so it has a placement here — made on first need, as ``local_deployment`` always has.
        """
        from flow_sdk.builtin.agent import Agent  # noqa: PLC0415
        from flow_sdk.builtin.deployment import KIND_AGENT, Deployment  # noqa: PLC0415
        from flow_sdk.worldview.ontology import kind_matches  # noqa: PLC0415

        agents: dict[str, Any] = {}

        async def agent_of(agent_id: str):
            if agent_id not in agents:
                agents[agent_id] = await Agent.get_by_id(agent_id) if agent_id else None
            return agents[agent_id]

        for agent_id in owned:
            agent = await agent_of(agent_id)
            if agent is not None:
                await agent.local_deployment()
        wanted: dict[str, tuple] = {}
        for deployment in await Deployment.get_all({"match": {"kind": KIND_AGENT}}):
            if not kind_matches(KIND_AGENT, deployment.kind) or not deployment.is_local:
                continue
            agent = await agent_of(str(deployment.parent_type_id or "").partition("-")[2])
            if agent is None or not agent.enabled_on(deployment.id):
                continue
            try:
                await ensure_chat_endpoint(agent, deployment)
            except Exception:  # noqa: BLE001 — one placement's endpoint must not stop the others
                logger.exception("agent %s: chat endpoint for %s failed", agent.id, deployment.id)
            wanted[str(deployment.id)] = (agent, deployment)
        return wanted

    async def _converge(self, wanted: dict[str, tuple], owned: dict[str, list]) -> None:
        from flow_sdk.request_context.detached import create_detached_task  # noqa: PLC0415

        for key in [k for k in self._loops if k not in wanted]:
            await _ended(self._loops.pop(key)[1])
        for key, (agent, deployment) in wanted.items():
            sources = [s for s in owned.get(agent.id, []) if await answers_here(s, deployment)]
            keys = frozenset(_serving_key(s) for s in sources)
            current = self._loops.get(key)
            if current is not None and current[0] == keys and not current[1].done():
                continue
            if current is not None:
                # Ended before its successor starts: one drain per placement, never two.
                await _ended(self._loops.pop(key)[1])
            if sources:
                await hold_positions(deployment, sources)
                loop = create_detached_task(_serving(agent, deployment, sources), name=f"agent-serve:{deployment.id}")
                self._loops[key] = (keys, loop)


async def _ended(loop) -> None:
    loop.cancel()
    await asyncio.gather(loop, return_exceptions=True)


async def _serving(agent, deployment, sources) -> None:
    try:
        await serve(agent, deployment, sources=sources)
    except Exception:  # noqa: BLE001 — a loop that fails is logged; the next reconcile restarts it
        logger.exception("agent %s: serve loop on %s failed", agent.id, deployment.id)


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
    "ensure_chat_endpoint",
    "hold_positions",
    "is_own_outgoing",
    "serve",
    "stamp_turn",
    "transcript_entries",
    "turn_key",
    "turns_of",
    "workdir_for",
]
