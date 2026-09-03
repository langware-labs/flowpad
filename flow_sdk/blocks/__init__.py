"""flow_sdk.blocks — the plain-Python workflow surface.

No engine, no hidden graph, no operators: blocks are ordinary classes, the
script's own ``async for`` loop is the orchestration, and every value that
moves between blocks is a DataSpec. A ``MessageSource`` request is an ephemeral
DataSpec whose source-owned correlation completes its sender. The rule
throughout: **the SDK introduces vocabulary, never rows** — entity-backed
blocks are views over entities that already exist (``DataSource``, ``Agent``,
``AgenticProcess``, the ingest and projection machinery), while
``MessageSource`` owns only a transient queue. Nothing here persists state of
its own.

The canonical program::

    async with workflow("mail-concierge"):
        inbox  = Inbox("me@agentmail.to", api_key=KEY)
        agent  = await get_agent("email-summarizer")

        async with agent.process_messages():
            async for m in inbox.listen():                # m: SourceItemSpec
                out   = await agent.process_message(m)    # out: RunOutput
                reply = EmailMessageSpec.reply_to(m, body=out.text)
                await inbox.send(reply)

Verbs live on their owners (``listen``, ``process_message``, ``send``);
control flow — allow lists, branches, errors, prints — is never configuration,
it is the Python between the calls.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import logging
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, AsyncIterator, Callable, Sequence

from pydantic import ConfigDict

from flow_sdk.builtin.source_item import (
    EmailMessageSpec,
    MessageSpec,
    SlackMessageSpec,
    SourceItemSpec,
    TelegramMessageSpec,
)
from flow_sdk.schema.data_spec.dataset_spec import FileRef
from flow_sdk.schema.data_spec.spec import DataSpec

from .delivery import Delivered
from .folder import Folder, FolderChange
from .merge import listen
from .message_source import MessageRequest, MessageSource, _MessageRequestExpired
from .search_index import SearchIndex

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.agent_registry import AgentRef

__all__ = [
    "Delivered",
    "EmailMessageSpec",
    "Folder",
    "FolderChange",
    "FileRef",
    "MessageSpec",
    "MessageRequest",
    "MessageSource",
    "Inbox",
    "RunOutput",
    "SearchIndex",
    "listen",
    "SlackMessageSpec",
    "TelegramMessageSpec",
    "workflow",
]

logger = logging.getLogger(__name__)

_AgentInput = SourceItemSpec | MessageRequest

_active_agent_runners: contextvars.ContextVar[dict[str, "_AgentRunner"] | None] = contextvars.ContextVar(
    "active_agent_runners", default=None
)

#: The active workflow name — a grouping stamp for observability, nothing more.
#: v1 carries it so spawned processes can be attributed; no engine reads it.
current_workflow: contextvars.ContextVar[str] = contextvars.ContextVar("current_workflow", default="")


@contextlib.asynccontextmanager
async def workflow(name: str):
    """Name the work happening inside — a stamp, not an engine.

    Everything a block does in this scope carries the name (process
    ``context_data``), so the observed activity can be grouped and rendered.
    The script remains the source of truth; exiting changes nothing.
    """
    token = current_workflow.set(name)
    try:
        yield
    finally:
        current_workflow.reset(token)


class RunOutput(DataSpec):
    """One agent turn's result, as a value — frozen; a value is a value.

    v1 carries the captured chat text and no files; parsing the turn against
    the persona's declared ``AgentSpec.output`` shape is the planned upgrade,
    and lands here without changing any caller.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    text: str = ""
    files: list[FileRef] = []


#: ``context_data`` key holding a session's turn records: ``{turn key: {status, text}}``.
_TURNS = "turns"
_STARTED, _DONE = "started", "done"
#: Records kept per session. A redelivery is always of a RECENT item; older records are noise.
_TURNS_KEPT = 200


def _turns(ap) -> dict:
    data = getattr(ap, "context_data", None) or {}
    turns = data.get(_TURNS) or {}
    return turns if isinstance(turns, dict) else {}


def _turn_key(m: _AgentInput) -> str:
    """One message, one key. The natural key when the message has one, else its own id."""
    source = getattr(m, "data_source_id", "") or ""
    segment = getattr(m, "segment_key", "") or ""
    external = str(getattr(m, "external_id", "") or "")
    return f"{source}:{segment}:{external}" if source else external


class _AgentRunner:
    """Runs an ``Agent``, one ``AgenticProcess`` per session.

    ``agent`` is the REAL ``Agent`` entity (``flow_sdk/builtin/agent.py``) or
    anything the registry resolves to one — a name or a TypeId. No SDK-side
    wrapper: the entity that answers *who* already exists, and resolution is
    lazy (``get_agent_local_deployment`` raises ``LookupError`` loudly for an
    unknown agent at first spawn — a constructor cannot await).

    ``session_key`` maps an inbound spec to a session identity: the SAME key
    routes to the SAME process (the conversation continues with its context),
    a new key spawns a fresh one from the agent. The default keys by
    provider thread — "each email thread is its own session".

    Plain class, no persistence: ``processes`` is an ordinary dict you can
    inspect; the processes themselves are the entities the rest of the system
    already knows.
    """

    def __init__(
        self,
        agent: "AgentRef",
        session_key: Callable[[_AgentInput], str] = lambda m: str(m.thread_key or m.external_id),
        max_processes: int = 4,
    ):
        if not agent or (isinstance(agent, str) and not agent.strip()):
            raise ValueError("agent message processing needs an agent (entity, name, or id)")
        self.agent = agent
        self.session_key = session_key
        self.max_processes = int(max_processes)
        self.processes: dict[str, object] = {}
        self.closed = False
        self._spawn_lock = asyncio.Lock()

    def _ensure_open(self) -> None:
        if self.closed:
            raise RuntimeError("agent message processing scope is closed")

    async def process_for(self, m: _AgentInput):
        """The session's process — reused on a key hit, spawned on a miss.

        The spawn goes through the agent's ``Deployment`` (the one sanctioned
        spawner from a persona) so worker, model, permission mode and
        subagents are the ones the ``agent.md`` declares — never hand-rolled.
        """
        self._ensure_open()
        key = str(self.session_key(m))
        async with self._spawn_lock:
            return await self._find_or_spawn(key)

    async def _find_or_spawn(self, key: str):
        """Admit one spawn at a time so key reuse and the cap stay atomic."""
        self._ensure_open()
        existing = self.processes.get(key)
        if existing is not None:
            return existing
        if len(self.processes) >= self.max_processes:
            raise RuntimeError(
                f"max_processes={self.max_processes} live sessions reached; key {key!r} would exceed the budget"
            )
        from flow_sdk.builtin.agent_registry import get_agent_local_deployment  # noqa: PLC0415

        deployment = await get_agent_local_deployment(self.agent)
        self._ensure_open()
        options: dict = {"visible": False}
        wf = current_workflow.get()
        if wf:
            options["context_data"] = {"workflow": wf, "session_key": key}
        ap = await deployment.create_process("", **options)
        await self._discard_if_closed(ap)
        await ap.save()
        await self._discard_if_closed(ap)
        self.processes[key] = ap
        return ap

    async def run(self, m: _AgentInput) -> RunOutput:
        """One turn: route by session, prompt with the message body, return
        the assistant's reply as a value.

        **Safe to call twice with the same message.** A listener redelivers an
        item after a crash, and a session is a thread — so a second turn on
        the same text would be a duplicate answer, not a repeat of the first.
        The turn is recorded on the process's own ``context_data`` (an entity,
        so durable) BEFORE the prompt, and its text after; a repeat answers
        from the record. Only a turn that was started and never finished asks
        the transcript, and only because that is the one case with no record.
        """
        from flow_sdk.app.actions.execute_prompt import _capture_assistant_reply  # noqa: PLC0415

        ap = await self.process_for(m)
        key = _turn_key(m)
        prior = _turns(ap).get(key)
        if prior and prior.get("status") == _DONE:
            return RunOutput(text=prior.get("text", ""), files=[])
        if prior and prior.get("status") == _STARTED:
            # We died mid-turn. Did the agent finish? The transcript knows.
            text = await _capture_assistant_reply(ap)
            if text:
                await self._record_turn(ap, key, text)
                return RunOutput(text=text, files=[])
        await self._stamp_turn(ap, key, {"status": _STARTED})
        outcome = await ap.prompt(m.body or m.name or "")
        # prompt() reports failure in its envelope, not by raising — a FAIL
        # left unchecked turns into an infinite transcript wait downstream.
        if getattr(outcome, "status", "SUCCESS") == "FAIL":
            raise RuntimeError(f"prompt failed: {getattr(outcome, 'message', outcome)}")
        text = await _capture_assistant_reply(ap)
        await self._record_turn(ap, key, text or "")
        return RunOutput(text=text or "", files=[])

    async def _record_turn(self, ap, key: str, text: str) -> None:
        await self._stamp_turn(ap, key, {"status": _DONE, "text": text})

    @staticmethod
    async def _stamp_turn(ap, key: str, entry: dict) -> None:
        """Write one turn's record, bounded so a long-lived session cannot grow it forever."""
        turns = dict(_turns(ap))
        turns[key] = entry
        if len(turns) > _TURNS_KEPT:
            for stale in list(turns)[: len(turns) - _TURNS_KEPT]:
                turns.pop(stale, None)
        data = dict(getattr(ap, "context_data", None) or {})
        data[_TURNS] = turns
        ap.context_data = data
        await ap.save()

    @staticmethod
    async def _exit_process(ap) -> None:
        """Exit one process without letting teardown mask the caller."""
        try:
            await ap.exit()
        except Exception:  # noqa: BLE001 — teardown must not mask the run
            logger.debug("blocks: process exit failed", exc_info=True)

    async def _discard_if_closed(self, ap) -> None:
        if self.closed:
            await self._exit_process(ap)
            self._ensure_open()

    async def close(self) -> None:
        """Exit every live session. Best-effort; safe to call twice."""
        self.closed = True
        for ap in list(self.processes.values()):
            await self._exit_process(ap)
        self.processes.clear()


def _agent_runner_key(agent: "AgentRef") -> str:
    return str(getattr(agent, "id", agent))


@contextlib.asynccontextmanager
async def _process_messages(agent: "AgentRef"):
    """Scope one private runner so repeated messages preserve their sessions."""
    key = _agent_runner_key(agent)
    active = _active_agent_runners.get() or {}
    if key in active:
        raise RuntimeError("this agent is already processing messages in the current context")

    runner = _AgentRunner(agent)
    token = _active_agent_runners.set({**active, key: runner})
    try:
        yield
    finally:
        try:
            await runner.close()
        finally:
            _active_agent_runners.reset(token)


async def _process_message(agent: "AgentRef", message: _AgentInput) -> RunOutput:
    """Run one message, reusing the active scope or closing a one-shot runner."""
    runner = (_active_agent_runners.get() or {}).get(_agent_runner_key(agent))
    if runner is not None:
        return await runner.run(message)
    runner = _AgentRunner(agent)
    try:
        return await runner.run(message)
    finally:
        await runner.close()


@contextlib.asynccontextmanager
async def _respond_to(agent: "AgentRef", source: MessageSource):
    """Run ``agent`` behind ``source`` for the lifetime of this scope."""
    async with _process_messages(agent):
        async with source.listen() as messages:

            async def serve() -> None:
                try:
                    async for message in messages:
                        answer = await _process_message(agent, message)
                        try:
                            await message.reply(answer.text)
                        except _MessageRequestExpired:
                            continue
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    source._fail(exc)
                    raise

            task = asyncio.create_task(serve())
            body_failed = False
            try:
                yield source
            except BaseException:
                body_failed = True
                raise
            finally:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
                except Exception:
                    if not body_failed:
                        raise


def _cadence(poll_every, driver) -> float:
    """Seconds between cycles: the caller's ask, else the driver's attention cadence, else 3."""
    if isinstance(poll_every, timedelta):
        return max(0.0, poll_every.total_seconds())
    if poll_every is not None:
        return max(0.0, float(poll_every))
    declared = getattr(driver, "attention_poll_seconds", None) if driver is not None else None
    return float(declared) if declared else 3.0


class Inbox:
    """One watched mailbox: the conversation surface of a message source.

    A view over the existing pair — the ``DataSource`` that watches the
    address (connected or reused here) and the projection that turns its
    items into conversations. No third "inbox" thing is created.
    """

    def __init__(
        self,
        address: str,
        *,
        api_key: str = "",
        provider: str = "agentmail",
        senders: Sequence[str] = (),
        **config,
    ):
        """``address`` is the mailbox/handle the block is ABOUT (an email
        address, a bot's @username); the provider decides what identifies the
        source (the driver's ``identity_config_key``). Provider-specific
        credentials pass as keyword config (``api_key=...``,
        ``bot_token=...``) and land on the DataSource verbatim."""
        self.address = str(address).strip()
        self.provider = provider
        self.senders = {s.strip().lower() for s in senders if s.strip()}
        self._config = {k: v for k, v in config.items() if v is not None}
        if api_key:
            self._config["api_key"] = api_key
        self._source = None

    def _identity(self) -> tuple[str, str]:
        """(config key, value) that names WHICH account this block watches —
        the driver owns the key; the value is the address unless the config
        already carries that key (a telegram bot's identity is its token)."""
        from flow_sdk.ingest.driver import get_driver  # noqa: PLC0415

        driver = get_driver(self.provider)
        key = getattr(driver, "identity_config_key", "inbox") if driver else "inbox"
        return key, str(self._config.get(key) or self.address).strip()

    async def _ensure_source(self):
        if self._source is not None:
            return self._source
        from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
        from flow_sdk.connections import require  # noqa: PLC0415
        from flow_sdk.ingest.driver import get_driver  # noqa: PLC0415

        # A provider that reads with a machine-level connection (Slack, Drive)
        # is checked HERE, before any row exists: ``NotConnected`` names the
        # fix, whereas a source created without it parks on its first poll.
        driver = get_driver(self.provider)
        if driver is not None and driver.connection:
            await require(driver.connection)

        key, value = self._identity()
        existing = await DataSource.find_for_account(self.provider, key, value)
        if existing is not None:
            self._source = existing
            return existing
        source = DataSource(
            name=f"Inbox {self.address}",
            provider=self.provider,
            config={key: value, **self._config},
        )
        await source.save()
        self._source = source
        return source

    async def listen(
        self,
        *,
        poll_every: "float | timedelta | None" = None,
        page: int = 100,
    ) -> AsyncIterator["Delivered[SourceItemSpec]"]:
        """Async-iterate inbound messages as they arrive, each with an ``ack()``.

        Each cycle polls the source through the poller's slot (a poll already in flight is
        skipped, not stacked), then drains what landed in INGEST order from the consumer's
        position. The position is durable inside a named ``workflow()`` — a restart resumes
        from the last ``ack()`` and hands back anything that was in flight with
        ``redelivered=True``. Outside a workflow it lives for the loop, as before.

        Items already present when a position is first created are the baseline: an inbox
        yields arrivals, not history. Our own sent copies and senders outside ``senders``
        are filtered — and ACKED, so a filtered row never becomes a gap the next drain
        stops at.

        ``poll_every`` defaults to the driver's attention cadence when it declares one, else
        3 s. The row's own ``poll_interval_seconds`` still governs the heartbeat; this is the
        rate of THIS loop.
        """
        from flow_sdk.builtin.consumer_position import ConsumerPosition, key_of  # noqa: PLC0415
        from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415
        from flow_sdk.inbox.projection import is_self_address, project_source_item  # noqa: PLC0415
        from flow_sdk.ingest.poller import poll_source  # noqa: PLC0415

        source = await self._ensure_source()
        position = await ConsumerPosition.ensure_for(
            current_workflow.get(), str(source.id), baseline=await SourceItem.newest_for(str(source.id))
        )
        cadence = _cadence(poll_every, self._driver())
        # The drain's own cursor. The durable watermark moves only on ack(); paging from it
        # alone would re-read every unacked item each cycle. On restart this is gone, so
        # everything after the watermark is yielded again — that IS the redelivery.
        last_seen = position.watermark()
        in_flight_at_start = position.in_flight_key()

        while True:
            await poll_source(source, datetime.now(timezone.utc))
            while True:
                rows = await SourceItem.page_after(str(source.id), last_seen, limit=page)
                if not rows:
                    break
                for item in rows:
                    key = key_of(item)
                    last_seen = key
                    redelivered = in_flight_at_start is not None and key <= in_flight_at_start
                    if position.mark_in_flight(item):
                        await position.commit()
                    # Place it in its conversation regardless of the filters below — the
                    # inbox UI shows everything; the LOOP only acts on what passes.
                    try:
                        await project_source_item(item, source=source, announce=False)
                    except Exception:  # noqa: BLE001 — projection trouble must not kill the loop
                        logger.exception("blocks: projection failed for %s", item.id)
                    sender = str(item.author_external_id or "").strip().lower()
                    if is_self_address(source, item.author_external_id or "") or (
                        self.senders and sender not in self.senders
                    ):
                        if position.advance_to(item):
                            await position.commit()
                        continue
                    spec = SourceItemSpec.model_validate({k: getattr(item, k) for k in SourceItemSpec.model_fields})
                    yield Delivered(
                        spec, position=position, row=item, source_id=str(source.id), redelivered=redelivered
                    )
            await asyncio.sleep(cadence)

    def _driver(self):
        from flow_sdk.ingest.driver import get_driver  # noqa: PLC0415

        return get_driver(self.provider)

    async def send(self, spec: MessageSpec) -> str:
        """Deliver an outbound spec through the source's messaging seam.

        Returns the provider's id for the created message — identity is born
        at the provider. The sent copy re-ingests on a later sync and joins
        its thread like any other message.
        """
        source = await self._ensure_source()
        outcome = await source.send(spec)
        return str(outcome.external_id or "")
