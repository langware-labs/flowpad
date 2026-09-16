"""``HarnessWorker`` — how the agent source's workers launch on this machine.

The ``agent`` source (``source.py`` beside this module) says WHAT a fetch or a send is; this
module owns HOW it runs here: the named Agent's deployment, the prompt contract, the
receipt file, and the two budgets that exist nowhere else in ingestion. ``AgenticProcess`` has
neither — ``run``/``wait`` poll forever and there is no global process cap — so without them one
stuck worker holds its source's in-flight slot permanently and N due sources spawn N workers.

**Fetch and send deliberately differ.** A fetch timeout is transient: a re-run is an upsert
behind the digest gate. A send timeout is CONFIG health carrying "outcome unknown": re-running
mails the recipient twice. Send failures raise ``LaunchError`` — never source health — so one
failed reply cannot park a mailbox.
"""
from __future__ import annotations

import asyncio
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Mapping

from flow_sdk.builtin.agentic_process.launch_health import (
    LaunchError,
    LaunchErrorCode,
    emit_launch_failed,
    ensure_launchable,
)
from flow_sdk.ingest.health import SourceError
from flow_sdk.ingest.sources import ingest_run_context

from .source import profile_of

logger = logging.getLogger(__name__)

#: Default wall-clock for one fetch; a source may override via ``config.deadline_seconds``. It exists so
#: a hung worker cannot hold its source's slot forever, not to paper over a slow provider.
DEFAULT_DEADLINE_SECONDS = 300
#: Concurrent ingest workers across ALL sources: every due source dispatches on one heartbeat tick.
MAX_CONCURRENT_AGENTS = 2
_slots = asyncio.Semaphore(MAX_CONCURRENT_AGENTS)
#: Where the worker leaves its account of a fetch. Named by us, not by it.
RECEIPT_FILENAME = "ingested.json"
#: The send verb's receipt — a separate name so the two verbs never read each other's.
SEND_RECEIPT_FILENAME = "sent.json"
#: A SEPARATE budget: a reply is foreground work, and sharing the poll semaphore would park it behind
#: two 300-second fetches, while no budget would let N clicks spawn N unbounded workers.
MAX_CONCURRENT_SENDS = 2
_send_slots = asyncio.Semaphore(MAX_CONCURRENT_SENDS)
#: Shorter than a fetch's: a fetch may sweep a mailbox, a send writes one message.
DEFAULT_SEND_DEADLINE_SECONDS = 120


class HarnessWorker:
    """The ``WorkerTransport`` the ``agent`` source is handed on this machine."""

    async def fetch(self, *, source_id: str, name: str, config: Mapping[str, Any], segment_key: str, since: str) -> dict:
        harness = config.get("harness") or None
        deadline = int(config.get("deadline_seconds") or DEFAULT_DEADLINE_SECONDS)
        target = f"data_source:{source_id}"
        # Pre-flight: a missing or logged-out harness costs a 5s probe, not a PTY.
        problem = await ensure_launchable(harness)
        if problem is not None:
            emit_launch_failed(problem, target)
            raise problem.as_source_error()
        async with _slots:
            try:
                return await asyncio.wait_for(self._run_fetch(source_id, name, config, harness, segment_key, since), timeout=deadline)
            except asyncio.TimeoutError:
                error = LaunchError.transient(LaunchErrorCode.TIMEOUT, f"the worker did not finish within {deadline}s", str(harness or ""))
                emit_launch_failed(error, target)
                raise error.as_source_error() from None
            except SourceError:
                raise
            except Exception as exc:  # noqa: BLE001 — classify, never leak
                error = LaunchError.classify(exc, str(harness or ""))
                emit_launch_failed(error, target)
                raise error.as_source_error() from exc

    async def send(
        self, *, source_id: str, config: Mapping[str, Any], channel: str, thread_key: str, to: str, text: str, subject: str, conversation_id: str
    ) -> dict:
        harness = config.get("harness") or None
        deadline = int(config.get("send_deadline_seconds") or DEFAULT_SEND_DEADLINE_SECONDS)
        target = f"conversation_send:{source_id}"
        problem = await ensure_launchable(harness)
        if problem is not None:
            emit_launch_failed(problem, target)
            raise problem
        async with _send_slots:
            try:
                receipt = await asyncio.wait_for(
                    self._run_send(source_id, config, harness, thread_key=thread_key, to=to, text=text, subject=subject,
                                   channel=channel, conversation_id=conversation_id),
                    timeout=deadline,
                )
            except asyncio.TimeoutError:
                # CONFIG, never transient: there must not BE a next attempt — the mail may already be gone.
                error = LaunchError.config(
                    LaunchErrorCode.TIMEOUT,
                    f"the worker did not finish within {deadline}s — the mail may or may not have been sent; check the channel before retrying",
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
        return send_result_from(receipt)

    # ── the spawn ─────────────────────────────────────────────────────────────

    async def _run_fetch(self, source_id: str, name: str, config: Mapping[str, Any], harness: Any, segment_key: str, since: str) -> dict:
        """Launch through the NAMED agent, the way every preset launch does, so the Agent's persona
        (worker, model, permission mode, subagents) is what runs."""
        from flow_sdk.builtin.agent_registry import get_agent_local_deployment  # noqa: PLC0415
        from flow_sdk.graph_workflow_manager.manager import execution_base  # noqa: PLC0415

        agent_name = str(config.get("agent") or profile_of(config).agent)
        try:
            deployment = await get_agent_local_deployment(agent_name)
        except LookupError as exc:
            raise SourceError.config("unknown_agent", str(exc)) from exc
        row = SimpleNamespace(id=source_id)
        options: dict[str, Any] = {
            "name": f"ingest {name or source_id[:8]} · {segment_key}",
            "visible": False,
            # The run's only handle: an ingest worker has no spawning entity to browse from.
            "context_data": ingest_run_context(row),
        }
        if harness:
            options["worker_type"] = harness
        proc = await deployment.create_process("", **options)
        base = execution_base(proc)
        (base / "output").mkdir(parents=True, exist_ok=True)
        receipt_path = base / "output" / RECEIPT_FILENAME
        instruction = fetch_instruction(row, config, receipt_path, segment_key=segment_key, since=since)
        proc.instruction_content = instruction
        await proc.save()
        response = await proc.prompt(instruction)
        if getattr(response, "status", None) and str(response.status).upper().endswith("FAIL"):
            raise SourceError.transient("launch_failed", str(getattr(response, "message", "") or "prompt refused"))
        await proc.wait()
        try:
            await proc.exit()
        except Exception:  # noqa: BLE001 — the run is what matters
            logger.debug("ingest/agent: exit failed", exc_info=True)
        receipt = read_receipt(receipt_path)
        receipt.setdefault("last_run_at", datetime.now(timezone.utc).isoformat())
        return receipt

    async def _run_send(
        self, source_id: str, config: Mapping[str, Any], harness: Any, *, thread_key: str, to: str, text: str, subject: str, channel: str, conversation_id: str
    ) -> dict:
        from flow_sdk.builtin.agent_registry import get_agent_local_deployment  # noqa: PLC0415
        from flow_sdk.graph_workflow_manager.manager import execution_base  # noqa: PLC0415

        agent_name = str(config.get("send_agent") or profile_of(config).send_agent)
        try:
            deployment = await get_agent_local_deployment(agent_name)
        except LookupError as exc:
            raise LaunchError.config(LaunchErrorCode.UNKNOWN, str(exc), "") from exc
        row = SimpleNamespace(id=source_id)
        options: dict[str, Any] = {
            "name": f"reply · {to}",
            "visible": False,
            # Provenance: without it a send is an anonymous worker the conversation cannot find again.
            "context_data": {
                **ingest_run_context(row),
                "channel_send": {"to": to, "thread_key": thread_key, "channel": channel, "conversation_id": conversation_id or ""},
            },
        }
        if harness:
            options["worker_type"] = harness
        proc = await deployment.create_process("", **options)
        base = execution_base(proc)
        (base / "output").mkdir(parents=True, exist_ok=True)
        receipt_path = base / "output" / SEND_RECEIPT_FILENAME
        instruction = send_instruction(row, config, receipt_path, thread_key=thread_key, to=to, text=text, subject=subject)
        proc.instruction_content = instruction
        await proc.save()
        response = await proc.prompt(instruction)
        if getattr(response, "status", None) and str(response.status).upper().endswith("FAIL"):
            raise LaunchError.config(LaunchErrorCode.UNKNOWN, str(getattr(response, "message", "") or "prompt refused"), "")
        await proc.wait()
        try:
            await proc.exit()
        except Exception:  # noqa: BLE001
            logger.debug("send worker exit failed", exc_info=True)
        return read_receipt(receipt_path)


# ── the contract a worker is handed ──────────────────────────────────────────


def accepted_fields() -> str:
    """The write route's field names, read off the schema that enforces them — so the next rename
    cannot silently reopen the gap the hand-written names once opened."""
    from flow_sdk.schema.data_spec.source_item_spec import SourceItemSpec  # noqa: PLC0415

    return ", ".join(f"`{name}`" for name in SourceItemSpec.model_fields)


def _run_prefix(source: Any, config: Mapping[str, Any]) -> list[str]:
    profile_of(config)  # every prompt re-asserts the invariant it prints
    return [f"- data-source id (`data_source_id`): `{source.id}`", f"- provider: `{config.get('connector')}`"]


def _run_suffix(receipt_path: Any, flow_cli: Path) -> list[str]:
    return [
        f"- receipt path: `{receipt_path}`",
        f"- the `flow` CLI to use, by absolute path: `{flow_cli}`",
        f"  (run exactly `{flow_cli} record create source_item --json <file>` — a bare `flow` on PATH may be an older build without this command)",
        f"- the ONLY field names the write route accepts, from its own schema: {accepted_fields()}. Any other key is refused "
        "and the whole batch is rejected — send no others, and spell these exactly.",
    ]


def _subagent_prompt(name: str) -> str:
    from flow_sdk.builtin.subagent_loading import load_subagent  # noqa: PLC0415

    try:
        agent = load_subagent(name)
        data = (getattr(agent, "data", None) or {}) if agent else {}
        return str(data.get("prompt") or data.get("prompt_text") or "")
    except Exception:  # noqa: BLE001 — the addendum alone is still runnable
        logger.debug("ingest/agent: subagent %s unavailable", name, exc_info=True)
        return ""


def fetch_instruction(source: Any, config: Mapping[str, Any], receipt_path: Any, *, segment_key: str, since: str) -> str:
    """The subagent markdown leads; only the per-run addendum is built here. The CLI is named by
    ABSOLUTE path: a stale ``flow`` on the worker's PATH once shadowed this backend's."""
    body = _subagent_prompt(str(config.get("subagent") or profile_of(config).subagent))
    flow_cli = Path(sys.executable).parent / "flow"
    run_lines = [
        *_run_prefix(source, config),
        f"- {profile_of(config).segment_noun} (`segment_key`): `{segment_key}`",
        f"- fetch messages newer than: `{since or '(no floor — fetch the most recent)'}`",
        f"- record at most {int(config.get('max_items') or 25)} messages, newest first",
        *_run_suffix(receipt_path, flow_cli),
    ]
    return f"{body}\n\n---\n## This run\n\n" + "\n".join(run_lines) + "\n"


def send_instruction(source: Any, config: Mapping[str, Any], receipt_path: Any, *, thread_key: str, to: str, text: str, subject: str) -> str:
    """The send contract plus this run's facts; the body is fenced so the model sees exactly where the
    user's words start and stop — it must send them verbatim."""
    body = _subagent_prompt(str(config.get("send_subagent") or profile_of(config).send_subagent))
    flow_cli = Path(sys.executable).parent / "flow"
    lines = [
        "", "---", "## This run", "",
        *_run_prefix(source, config),
        f"- reply into thread (`thread_key`): `{thread_key or '(none — start a new thread)'}`",
        f"- send to: `{to}`",
        f"- subject: `{subject or '(reuse the thread’s subject)'}`",
        *_run_suffix(receipt_path, flow_cli),
        "", "### The message body — send exactly this, and nothing else", "", "```", text, "```", "",
    ]
    return (body + "\n\n" + "\n".join(lines)) if body else "\n".join(lines)


# ── the receipt ──────────────────────────────────────────────────────────────


def read_receipt(path: Path) -> dict[str, Any]:
    """A missing receipt is a failed run, never an empty one: reading "nothing" as "nothing changed"
    would advance the cursor past mail that was never read."""
    try:
        raw = Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        raise SourceError.transient("no_receipt", f"the worker wrote no receipt at {path}: {exc}") from exc
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise SourceError.transient("bad_receipt", f"receipt is not JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise SourceError.transient("bad_receipt", "receipt is not a JSON object")
    return data


def send_result_from(receipt: dict) -> dict:
    """A send receipt, confirmed. Every failure is CONFIG health: no error, no send and no draft is
    ambiguous, and ambiguity must never read as success."""
    reported = receipt.get("error")
    if reported:
        code = LaunchErrorCode.NOT_AUTHENTICATED if str(reported) == "no_connector" else LaunchErrorCode.UNKNOWN
        raise LaunchError.config(code, str(reported), "")
    drafted = bool(receipt.get("drafted"))
    if not receipt.get("sent") and not drafted:
        raise LaunchError.config(LaunchErrorCode.UNKNOWN, "the worker returned a receipt that confirms neither a send nor a draft", "")
    return {
        "external_id": str(receipt.get("external_id") or receipt.get("draft_id") or ""),
        "drafted": drafted,
        # A draft has reached nobody, so it is never recorded as a message.
        "recorded": bool(receipt.get("recorded")) and not drafted,
        "artifact_id": str(receipt.get("artifact_id") or ""),
    }


def recorded_ids(receipt: dict[str, Any]) -> list[str]:
    """Provider ids a receipt claims — for tests and diagnostics."""
    ids = receipt.get("external_ids")
    return [str(i) for i in ids] if isinstance(ids, list) else []


__all__ = [
    "DEFAULT_DEADLINE_SECONDS", "DEFAULT_SEND_DEADLINE_SECONDS", "RECEIPT_FILENAME", "SEND_RECEIPT_FILENAME",
    "HarnessWorker", "accepted_fields", "fetch_instruction", "read_receipt", "recorded_ids", "send_instruction", "send_result_from",
]
