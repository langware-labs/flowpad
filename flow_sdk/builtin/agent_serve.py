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

import logging
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
    data = dict(getattr(ap, "context_data", None) or {})
    data[TURNS] = turns
    ap.context_data = data
    await ap.save()


# ── what a turn is asked with, and what it answers with ──────────────────────


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
        workdir = self.workdir or await workdir_for(self.agent)
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

    async def run(self, turn: Turn) -> TurnEvent:
        """The turn's outcome once it is over: ``done`` with the reply, or ``refused``."""
        last = TurnEvent("refused", "the turn produced nothing")
        async for event in self.run_stream(turn):
            last = event
        return last

    async def run_stream(self, turn: Turn) -> AsyncIterator[TurnEvent]:
        """Run *turn*, yielding what the agent writes as it writes it; the last event is ``done`` or ``refused``."""
        from flow_sdk.app.actions.execute_prompt import (  # noqa: PLC0415
            _capture_assistant_reply,
            _last_turn_assistant_text,
            conversation_turn_lock,
        )

        async with conversation_turn_lock(turn.session):
            ap = await self.process_for(turn.session, name=turn.name, context=turn.context)
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
            start = len(transcript_entries(ap))
            await stamp_turn(ap, turn.key, {"status": STARTED})
            taken = await ap.send_turn(turn.body)
            if not taken.ok:
                yield TurnEvent("refused", taken.detail or "the turn was not taken")
                return
            async for event in _follow(ap, start):
                yield event
            text = _last_turn_assistant_text(transcript_entries(ap)[start:]) or await _capture_assistant_reply(ap)
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
    import asyncio  # noqa: PLC0415

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


async def ensure_chat_endpoint(agent, deployment):
    """The placement's ``chat`` endpoint (``api.chat.openai``, answered by this app). Idempotent."""
    from flow_sdk.builtin.service_endpoint import ServiceEndpoint  # noqa: PLC0415
    from flow_sdk.builtin.webapp_placement import upsert_endpoint  # noqa: PLC0415
    from flow_sdk.schema.data_spec.service_endpoint_spec import PROTOCOL_API_CHAT_OPENAI  # noqa: PLC0415

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


def _inbox_of(source, agent):
    """A ``StreamInbox`` over an EXISTING source — the block's durable drain, no adoption step."""
    from flow_sdk.blocks import StreamInbox  # noqa: PLC0415

    inbox = StreamInbox("", provider=source.provider, owner=agent)
    inbox._source = source  # the row is already known; ``ensure_source`` would look it up again
    return inbox


async def serve(agent, deployment) -> None:
    """Answer every message on the agent's channels that answer on *deployment*, until cancelled.

    One durable drain (a named consumer per placement, so a restart resumes after
    the last answer) over all of them; each message passes the loop guard and the
    source's gate, runs through the turn engine in its conversation, and is
    replied to on its own channel (send → record → ack).
    """
    from flow_sdk.blocks import workflow  # noqa: PLC0415
    from flow_sdk.blocks.merge import pages  # noqa: PLC0415
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
    from flow_sdk.stream_inbox.agent_scope import is_message_source  # noqa: PLC0415

    sources = [
        s
        for s in await DataSource.find_owned(agent.typeid)
        if is_message_source(s) and await answers_here(s, deployment)
    ]
    if not sources:
        return
    by_id = {str(s.id): s for s in sources}
    engine = TurnEngine(agent, deployment)
    async with workflow(f"agent-serve:{deployment.id}"):
        async for page in pages(*(_inbox_of(s, agent) for s in sources)):
            source = by_id[page.source_id]
            for message in page:
                await _answer(engine, agent, source, message)
            await page.ack()


async def _answer(engine: TurnEngine, agent, source, message) -> None:
    """One channel message: gate it, run it in its conversation, reply on its channel."""
    from flow_sdk.stream_inbox.projection import display_name_of  # noqa: PLC0415

    author = str(getattr(message, "author_external_id", "") or "")
    body = str(getattr(message, "body", "") or "").strip()
    if is_own_outgoing(source, author) or not admits(source, author) or not body:
        return
    session = await _conversation_session(message, source)
    who = display_name_of(getattr(message, "author_display", "") or "", author)
    outcome = await engine.run(
        Turn(
            session=session,
            key=str(getattr(message, "id", "") or getattr(message, "external_id", "")),
            body=body,
            name=" · ".join(p for p in (agent.name, source.channel or source.provider, who) if p) or None,
        )
    )
    if outcome.kind != "done" or not outcome.text:
        logger.info("agent %s: no reply to %s (%s)", agent.name or agent.id, session, outcome.text or outcome.kind)
        return
    await message.reply(await message.reply_spec(body=outcome.text))


async def _conversation_session(message, source) -> str:
    """The conversation the message was placed in — its thread's, as the projection wrote it."""
    from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415
    from flow_sdk.schema.types import EntityType  # noqa: PLC0415
    from flow_sdk.stream_inbox.projection import channel_of, find_thread, owner_of, thread_key_for  # noqa: PLC0415

    row = getattr(message, "_row", None) or message
    owner = await owner_of(source)
    thread = await find_thread(
        channel_of(source), thread_key_for(row, getattr(row, "name", "") or ""), owner, str(source.id)
    )
    conversation = str(getattr(thread, "conversation_id", "") or "") or str(getattr(message, "thread_key", "") or "")
    return str(TypeId(type=EntityType.CONVERSATION.value, id=conversation)) if conversation else f"thread:{source.id}"


# ── the supervisor: one loop per agent placement on this machine ────────────


class AgentServer:
    """Keeps every agent placement on this machine serving.

    For each local ``runtime.agent`` Deployment whose agent is enabled there: its
    ``chat`` endpoint exists, and (when ``serve_channels``) one :func:`serve` task
    runs. Reconciled at start and whenever an agent, a placement or a source
    changes (``entity.*`` tags); a task whose placement went away is cancelled.
    """

    def __init__(self, *, serve_channels: bool):
        self.serve_channels = serve_channels
        self._tasks: dict[str, Any] = {}
        self._pending: Any = None
        self._unsubscribe: Any = None

    async def start(self) -> None:
        from flow_sdk.tags import on_tag  # noqa: PLC0415

        self._unsubscribe = on_tag("entity.*", self._on_entity)
        await self.reconcile()

    async def stop(self) -> None:
        import asyncio  # noqa: PLC0415

        if self._unsubscribe is not None:
            self._unsubscribe()
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks.clear()

    async def _on_entity(self, event) -> None:
        from flow_sdk.request_context.detached import create_detached_task  # noqa: PLC0415

        kind = str((event.data or {}).get("entity_type") or "")
        if kind not in ("agent", "deployment", "data_source"):
            return
        # Coalesced: a burst of writes (an agent saved with its placements) is one reconcile.
        if self._pending is None or self._pending.done():
            # Detached: the tag fires inside the writer's commit, whose session this must not join.
            self._pending = create_detached_task(self.reconcile(), name="agent-server-reconcile")

    async def reconcile(self) -> None:
        import asyncio  # noqa: PLC0415

        from flow_sdk.builtin.agent import Agent  # noqa: PLC0415
        from flow_sdk.builtin.deployment import KIND_AGENT, Deployment  # noqa: PLC0415
        from flow_sdk.worldview.ontology import kind_matches  # noqa: PLC0415

        wanted: dict[str, tuple] = {}
        for deployment in await Deployment.get_all({"match": {"kind": KIND_AGENT}}):
            if not kind_matches(KIND_AGENT, deployment.kind) or not deployment.is_local:
                continue
            agent_id = str(deployment.parent_type_id or "").partition("-")[2]
            agent = await Agent.get_by_id(agent_id) if agent_id else None
            if agent is None or not agent.enabled_on(deployment.id):
                continue
            try:
                await ensure_chat_endpoint(agent, deployment)
            except Exception:  # noqa: BLE001 — one placement's endpoint must not stop the others
                logger.exception("agent %s: chat endpoint for %s failed", agent.id, deployment.id)
            wanted[str(deployment.id)] = (agent, deployment)
        if not self.serve_channels:
            return
        for key in [k for k in self._tasks if k not in wanted or self._tasks[k].done()]:
            self._tasks.pop(key).cancel()
        for key, (agent, deployment) in wanted.items():
            if key not in self._tasks:
                self._tasks[key] = asyncio.get_running_loop().create_task(_serving(agent, deployment))


async def _serving(agent, deployment) -> None:
    try:
        await serve(agent, deployment)
    except Exception:  # noqa: BLE001 — a loop that fails is logged; the next reconcile restarts it
        logger.exception("agent %s: serve loop on %s failed", agent.id, deployment.id)


__all__ = [
    "AgentServer",
    "CHAT",
    "Turn",
    "TurnEngine",
    "TurnEvent",
    "admits",
    "answers_here",
    "ensure_chat_endpoint",
    "is_own_outgoing",
    "serve",
    "stamp_turn",
    "transcript_entries",
    "turns_of",
    "workdir_for",
]
