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
from datetime import datetime, timezone
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

from .message_source import MessageRequest, MessageSource, _MessageRequestExpired

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.agent_registry import AgentRef

__all__ = [
    "EmailMessageSpec",
    "FileRef",
    "MessageSpec",
    "MessageRequest",
    "MessageSource",
    "Inbox",
    "RunOutput",
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
        the assistant's reply as a value."""
        from flow_sdk.app.actions.execute_prompt import _capture_assistant_reply  # noqa: PLC0415

        ap = await self.process_for(m)
        outcome = await ap.prompt(m.body or m.name or "")
        # prompt() reports failure in its envelope, not by raising — a FAIL
        # left unchecked turns into an infinite transcript wait downstream.
        if getattr(outcome, "status", "SUCCESS") == "FAIL":
            raise RuntimeError(f"prompt failed: {getattr(outcome, 'message', outcome)}")
        text = await _capture_assistant_reply(ap)
        return RunOutput(text=text or "", files=[])

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

    async def listen(self, poll_every: float = 3.0) -> AsyncIterator[SourceItemSpec]:
        """Async-iterate inbound messages, as spec values, as they arrive.

        In-process: each cycle syncs the source (the driver fetch is plain
        HTTP), projects what landed, and yields the rows not seen before.
        Items already present when ``listen`` starts are the baseline — an
        inbox yields arrivals, not history. Our own outgoing copies are
        filtered (the loop guard), as are senders outside ``senders`` when
        one was given.
        """
        from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415
        from flow_sdk.inbox.projection import is_self_address, project_source_item  # noqa: PLC0415
        from flow_sdk.ingest.sync import sync_source  # noqa: PLC0415

        source = await self._ensure_source()
        seen = {str(i.id) for i in await SourceItem.get_all({"data_source_id": source.id})}
        while True:
            await sync_source(source, now=datetime.now(timezone.utc))
            items = await SourceItem.get_all({"data_source_id": source.id})
            items.sort(key=lambda i: str(i.occurred_at or ""))
            for item in items:
                if str(item.id) in seen:
                    continue
                seen.add(str(item.id))
                # Place it in its conversation regardless of the filters
                # below — the inbox UI shows everything; the LOOP only acts
                # on what passes.
                try:
                    await project_source_item(item, source=source, announce=False)
                except Exception:  # noqa: BLE001 — projection trouble must not kill the loop
                    logger.exception("blocks: projection failed for %s", item.id)
                if is_self_address(source, item.author_external_id or ""):
                    continue  # our own sent copy, re-ingested
                sender = str(item.author_external_id or "").strip().lower()
                if self.senders and sender not in self.senders:
                    continue
                yield SourceItemSpec.model_validate({k: getattr(item, k) for k in SourceItemSpec.model_fields})
            await asyncio.sleep(poll_every)

    async def send(self, spec: MessageSpec) -> str:
        """Deliver an outbound spec through the source's messaging seam.

        Returns the provider's id for the created message — identity is born
        at the provider. The sent copy re-ingests on a later sync and joins
        its thread like any other message.
        """
        source = await self._ensure_source()
        outcome = await source.send(spec)
        return str(outcome.external_id or "")
