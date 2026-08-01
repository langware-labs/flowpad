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
from flow_sdk.ingest.driver import FetchResult, StreamCursorView, StreamRef
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

