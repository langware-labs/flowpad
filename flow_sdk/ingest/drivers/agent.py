"""The agent transport — a driver whose fetch is a model.

Every other driver reaches its provider over HTTP. This one spawns a harness
worker and lets it use the connectors the user has already authorised, which is
what makes a source possible for systems we have no first-class integration
with (Gmail first; Slack, Calendar and Drive are the same shape with a
different prompt).

Generic on both axes on purpose: `config` names the harness, the connector and
the agent definition, so a second connector is a row of config rather than a
new driver.

**The agent records; this driver does not.** The worker calls
``flow record create source_item``, which goes through ``ingest_items`` — the
same chokepoint the poller uses, with the same deterministic ids and the same
digest gate. So ``fetch`` returns no items: they already landed, and ingesting
them a second time here would double every message. What it returns instead is
the receipt's account of what happened, which is what the cursor and
``sync.completed`` need.

Two budgets live here and nowhere else in ingestion. Both were approved
explicitly, because ``AgenticProcess`` has neither: ``run``/``wait`` poll
forever, and there is no global process cap. Without them one stuck worker
holds its source's ``_inflight`` slot permanently and N due sources spawn N
concurrent workers.
"""
from __future__ import annotations

import asyncio
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flow_sdk.builtin.agentic_process.launch_health import (
    LaunchError,
    LaunchErrorCode,
    emit_launch_failed,
    ensure_launchable,
)
from flow_sdk.ingest.driver import (
    FetchResult,
    SendOutcome,
    SendStatus,
    StreamCursorView,
    StreamRef,
)
from flow_sdk.ingest.health import SourceError

logger = logging.getLogger(__name__)

#: Default wall-clock for one fetch. A source may raise it via
#: `config.deadline_seconds`; it exists so a hung worker cannot hold its
#: source's in-flight slot forever, not to paper over a slow provider.
DEFAULT_DEADLINE_SECONDS = 300

#: Concurrent ingest workers across ALL sources. The poller dispatches every
#: due source on the same heartbeat tick, so without this a handful of
#: agent-backed sources become a handful of simultaneous PTYs.
MAX_CONCURRENT_AGENTS = 2
_slots = asyncio.Semaphore(MAX_CONCURRENT_AGENTS)

#: Where the worker leaves its account of the run. Named by us, not by it.
RECEIPT_FILENAME = "ingested.json"

#: The send verb's receipt. A separate name so the two verbs can never read
#: each other's account of a run.
SEND_RECEIPT_FILENAME = "sent.json"

#: A SEPARATE budget from `_slots`. A reply is foreground work: sharing the
#: poll semaphore would park it behind up to two 300-second mailbox fetches
#: while the user watches a spinner, and dropping the budget entirely would let
#: N clicks spawn N unbounded workers — the exact failure the module docstring
#: says these caps exist to prevent. This is the codebase's first
#: foreground/background distinction; it is deliberate and it is small.
MAX_CONCURRENT_SENDS = 2
_send_slots = asyncio.Semaphore(MAX_CONCURRENT_SENDS)

#: The send deadline. Shorter than the fetch's 300s: a fetch may sweep a
#: mailbox, a send writes one message.
DEFAULT_SEND_DEADLINE_SECONDS = 120

#: The Agent that owns replying. NOT `email-summarizer` — that persona's own
#: prose says "You do not open the mailbox".
DEFAULT_SEND_AGENT = "emailer"

#: Its task contract for this verb.
DEFAULT_SEND_SUBAGENT = "email_sender"

#: The shipped Agent a source uses unless its config names another. An Agent —
#: not a raw prompt — so the worker, model and subagents are the ones a user can
#: see and edit under the assistant project.
DEFAULT_AGENT = "email-summarizer"

#: The extraction contract the run actually follows (the Agent's persona sets
#: who is working; this sets what this turn must do).
DEFAULT_SUBAGENT = "email_analyzer"


class AgentDriver:
    """One driver, any connector. `provider` stays `agent`; the connector rides
    in `kind` so the ontology reads `datasource.agent.<connector>`."""

    provider = "agent"
    kind = "datasource.agent"
    record_kind = "content.message.email"
    #: This transport can push a message back to its channel — see `send`.
    sends = True

    def channel_for(self, source) -> str:
        """The connector IS the channel — `gmail`, later `slack`, `jira`.

        Without this every agent-transport source would badge as "agent" and
        thread under it, so a Gmail thread later ingested by a direct API
        driver would land in a different conversation.
        """
        return str((source.config or {}).get("connector") or "").strip()

    def streams(self, source) -> list[StreamRef]:
        config = getattr(source, "config", None) or {}
        keys = config.get("streams") or [config.get("stream") or "INBOX"]
        return [StreamRef(key=str(k), label=str(k)) for k in keys]

    async def fetch(self, source, cursor: StreamCursorView) -> FetchResult:
        config = getattr(source, "config", None) or {}
        harness = config.get("harness") or None
        deadline = int(config.get("deadline_seconds") or DEFAULT_DEADLINE_SECONDS)

        # Pre-flight. A missing or logged-out harness is a config_error the
        # operator must fix — learning that costs a 5s probe instead of a PTY.
        launch_problem = await ensure_launchable(harness)
        if launch_problem is not None:
            emit_launch_failed(launch_problem, f"data_source:{source.id}")
            raise launch_problem.as_source_error()

        async with _slots:
            try:
                receipt = await asyncio.wait_for(
                    self._run_agent(source, cursor, config, harness), timeout=deadline
                )
            except asyncio.TimeoutError:
                error = LaunchError.transient(
                    LaunchErrorCode.TIMEOUT,
                    f"the worker did not finish within {deadline}s",
                    str(harness or ""),
                )
                emit_launch_failed(error, f"data_source:{source.id}")
                raise error.as_source_error() from None
            except SourceError:
                raise
            except Exception as exc:  # noqa: BLE001 — classify, never leak
                error = LaunchError.classify(exc, str(harness or ""))
                emit_launch_failed(error, f"data_source:{source.id}")
                raise error.as_source_error() from exc

        return self._result_from(receipt, cursor)

    # ── the send verb ─────────────────────────────────────────────────────────

    async def send(self, source, *, thread_key: str, to: str, text: str,
                   subject: str = "", conversation_id: str = "") -> SendOutcome:
        """Reply into the channel, and record the reply the same way an inbound
        message is recorded.

        Deliberately NOT symmetric with ``fetch`` in two places, both of which
        would be bugs if copied:

        1. **No ``SourceError``.** ``as_source_error()`` produces a health that
           parks the DataSource — one failed reply would stop the mailbox
           syncing. ``LaunchError`` propagates instead and is converted at the
           API boundary, where ``as_dict()`` is already the right shape.
        2. **A timeout is not a failure, and never a retry.** ``fetch`` classes
           TIMEOUT as transient because a re-run is an upsert behind the digest
           gate. A send has no such gate: re-running mails the recipient twice.
           So a timeout raises a CONFIG-health error — the one health that
           forbids automatic re-attempts — carrying "outcome unknown".
        """
        config = getattr(source, "config", None) or {}
        harness = config.get("harness") or None
        deadline = int(config.get("send_deadline_seconds") or DEFAULT_SEND_DEADLINE_SECONDS)
        target = f"conversation_send:{source.id}"

        launch_problem = await ensure_launchable(harness)
        if launch_problem is not None:
            emit_launch_failed(launch_problem, target)
            raise launch_problem

        async with _send_slots:
            try:
                receipt = await asyncio.wait_for(
                    self._run_send_agent(source, config, harness,
                                         thread_key=thread_key, to=to,
                                         text=text, subject=subject,
                                         channel=self.channel_for(source),
                                         conversation_id=conversation_id),
                    timeout=deadline,
                )
            except asyncio.TimeoutError:
                # CONFIG, not transient — transient means "the next attempt may
                # succeed", and there must not BE a next attempt: the mail may
                # already be gone.
                error = LaunchError.config(
                    LaunchErrorCode.TIMEOUT,
                    f"the worker did not finish within {deadline}s — the mail may "
                    f"or may not have been sent; check the channel before retrying",
                    str(harness or ""),
                )
                emit_launch_failed(error, target)
                raise error from None
            except LaunchError:
                raise
            except Exception as exc:  # noqa: BLE001 — classify, never leak
                error = LaunchError.classify(exc, str(harness or ""))
                emit_launch_failed(error, target)
                raise error from exc

        return self._send_result_from(receipt)

    @staticmethod
    def _send_result_from(receipt: dict) -> SendOutcome:
        """Read the send receipt. Mirrors ``_result_from``'s error mapping, but
        every failure here is CONFIG health for the reason in ``send``."""
        reported = receipt.get("error")
        if reported:
            raise LaunchError.config(
                LaunchErrorCode.NOT_AUTHENTICATED if str(reported) == "no_connector"
                else LaunchErrorCode.UNKNOWN,
                str(reported), "",
            )
        drafted = bool(receipt.get("drafted"))
        if not receipt.get("sent") and not drafted:
            # No error, no send and no draft is still not an outcome.
            raise LaunchError.config(
                LaunchErrorCode.UNKNOWN,
                "the worker returned a receipt that confirms neither a send nor a draft",
                "",
            )
        return SendOutcome(
            external_id=str(receipt.get("external_id") or receipt.get("draft_id") or ""),
            status=SendStatus.DRAFTED if drafted else SendStatus.SENT,
            recorded=bool(receipt.get("recorded")),
        )

    async def _run_send_agent(self, source, config: dict, harness,
                              *, thread_key: str, to: str, text: str,
                              subject: str, channel: str = "",
                              conversation_id: str = "") -> dict:
        """One agent turn that sends and records. Same build/save/prompt/wait
        shape as ``_run_agent`` — ``build`` (not ``launch``) because the receipt
        path must be known before the run starts."""
        from flow_sdk.builtin.agent_registry import get_agent_local_deployment  # noqa: PLC0415
        from flow_sdk.graph_workflow_manager.manager import execution_base  # noqa: PLC0415

        agent_name = str(config.get("send_agent") or DEFAULT_SEND_AGENT)
        try:
            deployment = await get_agent_local_deployment(agent_name)
        except LookupError as exc:
            raise LaunchError.config(LaunchErrorCode.UNKNOWN, str(exc), "") from exc

        options: dict = {
            "name": f"reply · {to}",
            "visible": False,
            # Provenance in the same channel the flow engine uses. Without it a
            # send is an anonymous worker: the Runs list cannot say what it was
            # for, and the conversation cannot find its own in-flight replies
            # after a reload.
            "context_data": {"channel_send": {
                "to": to, "thread_key": thread_key, "channel": channel,
                "conversation_id": conversation_id or "",
            }},
        }
        if harness:
            options["worker_type"] = harness
        proc = await deployment.build("", **options)

        base = execution_base(proc)
        (base / "output").mkdir(parents=True, exist_ok=True)
        receipt_path = base / "output" / SEND_RECEIPT_FILENAME

        instruction = self._send_instruction(
            source, config, receipt_path,
            thread_key=thread_key, to=to, text=text, subject=subject,
        )
        proc.instruction_content = instruction
        await proc.save()

        response = await proc.prompt(instruction)
        if getattr(response, "status", None) and str(response.status).upper().endswith("FAIL"):
            raise LaunchError.config(
                LaunchErrorCode.UNKNOWN,
                str(getattr(response, "message", "") or "prompt refused"), "",
            )
        await proc.wait()
        try:
            await proc.exit()
        except Exception:  # noqa: BLE001
            logger.debug("send worker exit failed", exc_info=True)

        return self._read_receipt(receipt_path)

    @staticmethod
    def _send_instruction(source, config: dict, receipt_path,
                          *, thread_key: str, to: str, text: str,
                          subject: str) -> str:
        """The send contract plus this run's facts.

        Same shape as ``_instruction``: the subagent markdown is the contract,
        and everything below `## This run` is what changes per send. The body
        is fenced rather than inlined so the model can see exactly where the
        user's words start and stop — it must send them verbatim.
        """
        from flow_sdk.fs_store.operations.subagent import load_subagent  # noqa: PLC0415

        body = ""
        try:
            agent = load_subagent(str(config.get("send_subagent") or DEFAULT_SEND_SUBAGENT))
            data = getattr(agent, "data", None) or {}
            body = str(data.get("prompt") or data.get("prompt_text") or "")
        except Exception:  # noqa: BLE001 — the addendum alone is still runnable
            logger.debug("send subagent load failed", exc_info=True)

        flow_cli = Path(sys.executable).parent / "flow"
        lines = [
            "",
            "---",
            "## This run",
            "",
            f"- data-source id (`source_id`): `{source.id}`",
            f"- provider: `{config.get('connector') or 'gmail'}`",
            f"- reply into thread (`thread_key`): `{thread_key or '(none — start a new thread)'}`",
            f"- send to: `{to}`",
            f"- subject: `{subject or '(reuse the thread’s subject)'}`",
            f"- receipt path: `{receipt_path}`",
            f"- the `flow` CLI to use, by absolute path: `{flow_cli}`",
            "  (run exactly `… record create source_item --json <file>` — a bare",
            "  `flow` on PATH may be an older build without this command)",
            "",
            "### The message body — send exactly this, and nothing else",
            "",
            "```",
            text,
            "```",
            "",
        ]
        return (body + "\n\n" + "\n".join(lines)) if body else "\n".join(lines)

    # ── the spawn ─────────────────────────────────────────────────────────────

    async def _run_agent(self, source, cursor: StreamCursorView,
                         config: dict, harness) -> dict[str, Any]:
        """Launch through the NAMED agent, the way every preset launch now does.

        `deployment.launch(prompt, wait=True)` is the shipped one-shot: it
        builds the process from the Agent's persona (worker, model, permission
        mode, subagents), saves it, runs the first turn, and polls to terminal.
        Hand-rolling `start_pty` + a busy/idle watcher here would fork that —
        and would silently ignore whatever the Agent declares.
        """
        from flow_sdk.builtin.agent_registry import get_agent_local_deployment  # noqa: PLC0415
        from flow_sdk.graph_workflow_manager.manager import execution_base  # noqa: PLC0415

        agent_name = str(config.get("agent") or DEFAULT_AGENT)
        try:
            deployment = await get_agent_local_deployment(agent_name)
        except LookupError as exc:
            # A source naming an agent that does not exist needs a human, not a
            # retry — same verdict the harness-missing case gets.
            raise SourceError.config("unknown_agent", str(exc)) from exc

        # `build` mints the process id, so the record dir is known before the
        # run — the same pre-save convention the flow engine's agent node uses
        # to tell an agent where to write.
        proc = await deployment.build("", **self._launch_options(source, cursor, harness))
        base = execution_base(proc)
        (base / "output").mkdir(parents=True, exist_ok=True)
        receipt_path = base / "output" / RECEIPT_FILENAME

        instruction = self._instruction(source, cursor, config, receipt_path)
        proc.instruction_content = instruction
        await proc.save()

        response = await proc.prompt(instruction)
        if getattr(response, "status", None) and str(response.status).upper().endswith("FAIL"):
            raise SourceError.transient(
                "launch_failed", str(getattr(response, "message", "") or "prompt refused")
            )
        await proc.wait()
        try:
            await proc.exit()
        except Exception:  # noqa: BLE001 — the run is what matters
            logger.debug("ingest/agent: exit failed", exc_info=True)

        return self._read_receipt(receipt_path)

    @staticmethod
    def _launch_options(source, cursor: StreamCursorView, harness) -> dict[str, Any]:
        """Only what this run overrides. Worker and model come from the Agent."""
        options: dict[str, Any] = {
            "name": f"ingest {source.name or source.id[:8]} · {cursor.stream_key}",
            "visible": False,
        }
        if harness:
            options["worker_type"] = harness
        return options

    def _instruction(self, source, cursor: StreamCursorView,
                     config: dict, receipt_path: Path) -> str:
        """The agent md leads; only the runtime addendum is built here — the
        shipped convention (see `asset_cleanup`)."""
        from flow_sdk.fs_store.operations.subagent import load_subagent  # noqa: PLC0415

        body = ""
        try:
            agent = load_subagent(str(config.get("subagent") or DEFAULT_SUBAGENT))
            data = (getattr(agent, "data", None) or {}) if agent else {}
            body = str(data.get("prompt") or data.get("prompt_text") or "")
        except Exception:  # noqa: BLE001 — the addendum alone is still runnable
            logger.debug("ingest/agent: agent definition unavailable", exc_info=True)

        window = cursor.window_start or "(no floor — fetch the most recent)"
        # ABSOLUTE path, never bare `flow`. The worker inherits a PATH where a
        # stale `flow` can win (a pyenv shim shadowed the venv here and the
        # agent got "No such command 'create'" from a CLI older than this
        # backend). `flow_cli_env_path` exists to pin the same binary; naming it
        # outright removes the resolution step entirely.
        flow_cli = Path(sys.executable).parent / "flow"
        seen = (cursor.state or {}).get("high_water")
        return (
            f"{body}\n\n---\n"
            f"## This run\n\n"
            f"- data-source id (`source_id`): `{source.id}`\n"
            f"- provider: `{config.get('connector') or 'gmail'}`\n"
            f"- mailbox (`stream_key`): `{cursor.stream_key}`\n"
            f"- fetch messages newer than: `{seen or window}`\n"
            f"- record at most {int(config.get('max_items') or 25)} messages, newest first\n"
            f"- receipt path: `{receipt_path}`\n"
            f"- the `flow` CLI to use, by absolute path: `{flow_cli}`\n"
            f"  (run exactly `{flow_cli} record create source_item --json <file>` — "
            f"a bare `flow` on PATH may be an older build without this command)\n"
        )

    # ── the receipt ───────────────────────────────────────────────────────────

    @staticmethod
    def _read_receipt(path: Path) -> dict[str, Any]:
        """A missing receipt is a failed run, not an empty one.

        The distinction matters: treating "the worker produced nothing" as
        "nothing has changed" would advance the cursor past mail that was never
        read, and the gap would be invisible.
        """
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise SourceError.transient(
                "no_receipt", f"the worker wrote no receipt at {path}: {exc}"
            ) from exc
        try:
            data = json.loads(raw)
        except ValueError as exc:
            raise SourceError.transient("bad_receipt", f"receipt is not JSON: {exc}") from exc
        if not isinstance(data, dict):
            raise SourceError.transient("bad_receipt", "receipt is not a JSON object")
        return data

    @staticmethod
    def _result_from(receipt: dict[str, Any], cursor: StreamCursorView) -> FetchResult:
        reported = receipt.get("error")
        if reported:
            # `no_connector` cannot be fixed by trying again; anything else the
            # agent names is assumed retryable, matching `classify`'s default.
            if str(reported) == "no_connector":
                raise SourceError.config("no_connector",
                                         "the harness has no email connector in this session")
            raise SourceError.transient(str(reported), "reported by the ingest agent")

        count = int(receipt.get("count") or 0)
        state = dict(cursor.state or {})
        high_water = receipt.get("high_water") or None
        if high_water:
            state["high_water"] = str(high_water)
        state["last_run_at"] = datetime.now(timezone.utc).isoformat()

        # No items: the worker already recorded them through the ingest route,
        # so handing them back would ingest every message twice.
        return FetchResult(
            items=[],
            next_state=state,
            high_water=str(high_water) if high_water else None,
            unchanged=(count == 0),
        )


def recorded_ids(receipt: dict[str, Any]) -> list[str]:
    """Provider ids the receipt claims — exposed for tests and diagnostics."""
    ids = receipt.get("external_ids")
    return [str(i) for i in ids] if isinstance(ids, list) else []

