"""flow_sdk.blocks — the plain-Python workflow surface.

No engine, no hidden graph, no operators: blocks are ordinary classes, the
script's own ``async for`` loop is the orchestration, and every value that
moves between blocks is a DataSpec. The rule throughout: **the SDK introduces
vocabulary, never rows** — each block is a view over entities that already
exist (``DataSource``, ``Agent``, ``AgenticProcess``, the ingest and
projection machinery); nothing here persists state of its own.

The canonical program::

    async with workflow("mail-concierge"):
        inbox  = Inbox("me@agentmail.to", api_key=KEY)
        runner = AgentRunner("email-summarizer")

        async for m in inbox.listen():                    # m: SourceItemSpec
            out   = await runner.run(m)                   # out: RunOutput
            reply = EmailMessageSpec.reply_to(m, body=out.text)
            await inbox.send(reply)

Verbs live on blocks (``listen``, ``run``, ``send``); control flow — allow
lists, branches, errors, prints — is never configuration, it is the Python
between the calls.
"""
from __future__ import annotations

import asyncio
import contextlib
import contextvars
import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING, AsyncIterator, Callable, Sequence

from pydantic import ConfigDict

from flow_sdk.builtin.source_item import EmailMessageSpec, MessageSpec, SourceItemSpec
from flow_sdk.schema.data_spec.dataset_spec import FileRef
from flow_sdk.schema.data_spec.spec import DataSpec

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.agent_registry import AgentRef

__all__ = [
    "AgentRunner",
    "EmailMessageSpec",
    "FileRef",
    "MessageSpec",
    "Inbox",
    "RunOutput",
    "workflow",
]

logger = logging.getLogger(__name__)

#: The active workflow name — a grouping stamp for observability, nothing more.
#: v1 carries it so spawned processes can be attributed; no engine reads it.
current_workflow: contextvars.ContextVar[str] = contextvars.ContextVar(
    "current_workflow", default=""
)


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


class AgentRunner:
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
        session_key: Callable[[SourceItemSpec], str] = lambda m: str(
            m.thread_key or m.external_id
        ),
        max_processes: int = 4,
    ):
        if not agent or (isinstance(agent, str) and not agent.strip()):
            raise ValueError("AgentRunner needs an agent (entity, name, or id)")
        self.agent = agent
        self.session_key = session_key
        self.max_processes = int(max_processes)
        self.processes: dict[str, object] = {}

    async def process_for(self, m: SourceItemSpec):
        """The session's process — reused on a key hit, spawned on a miss.

        The spawn goes through the agent's ``Deployment`` (the one sanctioned
        spawner from a persona) so worker, model, permission mode and
        subagents are the ones the ``agent.md`` declares — never hand-rolled.
        """
        key = str(self.session_key(m))
        existing = self.processes.get(key)
        if existing is not None:
            return existing
        if len(self.processes) >= self.max_processes:
            raise RuntimeError(
                f"max_processes={self.max_processes} live sessions reached; "
                f"key {key!r} would exceed the budget"
            )
        from flow_sdk.builtin.agent_registry import get_agent_local_deployment  # noqa: PLC0415

        deployment = await get_agent_local_deployment(self.agent)
        options: dict = {"visible": False}
        wf = current_workflow.get()
        if wf:
            options["context_data"] = {"workflow": wf, "session_key": key}
        ap = await deployment.build("", **options)
        await ap.save()
        self.processes[key] = ap
        return ap

    async def run(self, m: SourceItemSpec) -> RunOutput:
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

    async def close(self) -> None:
        """Exit every live session. Best-effort; safe to call twice."""
        for ap in list(self.processes.values()):
            try:
                await ap.exit()
            except Exception:  # noqa: BLE001 — teardown must not mask the run
                logger.debug("blocks: process exit failed", exc_info=True)
        self.processes.clear()


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
                yield SourceItemSpec.model_validate(
                    {k: getattr(item, k) for k in SourceItemSpec.model_fields}
                )
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
