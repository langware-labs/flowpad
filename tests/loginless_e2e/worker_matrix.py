"""Every harness x a few cheap non-vendor models, on a machine that never logged in.

Run AFTER ``flow llm user use <public-endpoint-id>``. One print-mode turn per cell; a cell passes
when the assistant's own words contain the expected one. Prints a table and exits non-zero if any
cell failed, so a container run is its own verdict.

    python worker_matrix.py                      # all installed harnesses x MODELS
    python worker_matrix.py claude codex         # only these harnesses
"""

import asyncio
import json
import os
import re
import shutil
import sys
import tempfile
import time

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.status_predicates import is_turn_busy
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowElementType
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.transcript_analyzer.worker_status import WorkerStatus

PROMPT = 'Reply with exactly the single word "pong" and nothing else.'
EXPECTED = "pong"
#: The same bound ``tests/long_tests/test_llm_endpoint_workers.py`` gives one turn.
TURN_DEADLINE_S = 240.0

#: OpenRouter slugs. All three are in the hub's price table -- a public endpoint carries a cost
#: limit, and the hub refuses a model it cannot price where a cost limit could not meter it.
#: ``MATRIX_MODELS`` (comma-separated) swaps them: a Vertex root is proven with
#: ``anthropic/claude-sonnet-4.6,z-ai/glm-5,openai/gpt-oss-120b`` -- the hub maps each onto its Vertex name.
MODELS = [m.strip() for m in os.environ.get("MATRIX_MODELS", "").split(",") if m.strip()] or [
    "moonshotai/kimi-k2.5",
    "z-ai/glm-4.7-flash",
    "qwen/qwen3-coder-30b-a3b-instruct",
]

#: ``(worker, binary, how that CLI spells an OpenRouter slug)`` -- opencode namespaces by provider.
WORKERS = [
    (WorkerType.CLAUDE_CODE, "claude", "{slug}"),
    (WorkerType.CODEX, "codex", "{slug}"),
    (WorkerType.COPILOT, "copilot", "{slug}"),
    (WorkerType.OPENCODE, "opencode", "openrouter/{slug}"),
    # In-process (flow_sdk's own runner), so "installed" means the python running this script.
    (WorkerType.DEEPAGENTS, "python", "{slug}"),
]


def _said(history: list) -> str:
    """Everything the assistant SAID -- its ``chat`` elements, never the prompt or its reasoning."""
    return " ".join(
        str(item.flow_value)
        for item in history
        if (item.attributes or {}).get("role") == "assistant" and (item.attributes or {}).get("element-type") == "chat"
    )


def terminal_error(history) -> dict | None:
    """Read canonical replay frames; expose classifications, never raw error messages."""
    for frame in reversed(history):
        attrs = frame.attributes or {}
        entry = (frame.process_entry or {}).get("transcript_entry", {})
        subtype = entry.get("subtype") or attrs.get("subtype")
        if not (attrs.get("element-type") in (FlowElementType.ERROR, FlowElementType.WORKER_UNAVAILABLE)
                or subtype in ("turn.failed", "event_msg.error")
                or attrs.get("outcome") in ("error", "failed", "failure")):
            continue
        summary = {"kind": "terminal_worker_error"}
        payload = entry.get("payload") or frame.flow_value
        for _ in range(5):
            if isinstance(payload, str):
                try:
                    payload = json.loads(payload)
                except ValueError:
                    break
            if not isinstance(payload, dict):
                break
            for key in ("code", "type", "param"):
                value = payload.get(key)
                if isinstance(value, int) or (isinstance(value, str) and re.fullmatch(r"[a-zA-Z0-9_.-]{1,64}", value)):
                    summary[key] = value
            payload = payload.get("error", payload.get("message"))
        return summary
    return None


def selected_workers(names: list[str]) -> list[tuple]:
    """Reject typos instead of reporting a zero-cell successful matrix."""
    known = {name for worker, binary, _ in WORKERS for name in (worker.value, binary)}
    unknown = set(names) - known
    if unknown:
        raise ValueError(f"unknown workers: {', '.join(sorted(unknown))}")
    return [row for row in WORKERS if not names or row[0].value in names or row[1] in names]


async def _source_evidence(process: AgenticProcess, model: str) -> str:
    from flow_sdk.instance_settings.llm_endpoint import get_hub_llm_endpoint

    bound = get_hub_llm_endpoint()
    if bound is None:
        raise ValueError("no bound endpoint; run flow llm user use first")
    actual = getattr(process, "resolved_llm_endpoint_typeid", None)
    if actual != bound.endpoint_typeid:
        raise ValueError(f"wrong or unproven source: {actual}, expected {bound.endpoint_typeid}")
    resolved = process.resolved_model_slug
    if not resolved or resolved.removeprefix("openrouter/") != model.removeprefix("openrouter/"):
        raise ValueError(f"wrong model: {resolved!r}, expected {model!r}")
    return f"source={bound.endpoint_typeid} model={resolved}"


async def verify_cli_turn(process_id: str, model: str) -> str:
    """Verify the CLI's persisted assistant response, not arbitrary captured stdout."""
    process = await AgenticProcess.get_by_id(process_id.removeprefix("agentic_process-"))
    if process is None:
        raise ValueError(f"CLI process not found: {process_id}")
    status = process.fetch_worker_status()
    if is_turn_busy(process, status) or status != WorkerStatus.COMPLETE:
        raise ValueError(f"CLI turn did not complete successfully: {status}")
    history = process.driver.load_history(process) or []
    failure = terminal_error(history)
    if failure:
        raise ValueError(f"CLI turn failed: {failure}")
    said = _said(history)
    if not said.strip():
        raise ValueError("CLI turn has no assistant chat output")
    return f"{await _source_evidence(process, model)} answer={said.strip()[:80]}"


async def _turn(worker_type: WorkerType, model: str) -> tuple[bool, str]:
    process = await AgenticProcess(
        worker_type=worker_type,
        workdir=tempfile.mkdtemp(),
        cli_config={"model": model, "permission_mode": "bypassPermissions"},
        pty_mode=False,
        visible=False,
        load_flowpad_assistant=False,
    ).save()
    try:
        result = await process.prompt(PROMPT)
        if getattr(result, "status", "SUCCESS") == "FAIL":
            return False, f"prompt refused: {getattr(result, 'message', result)}"
        deadline = time.monotonic() + TURN_DEADLINE_S
        said, status, history = "", None, []
        while time.monotonic() < deadline:
            fresh = await AgenticProcess.get_by_id(process.id) or process
            status = fresh.fetch_worker_status()
            if not is_turn_busy(fresh, status):
                history = fresh.driver.load_history(fresh) or []
                failure = terminal_error(history)
                if failure:
                    return False, f"turn failed: {failure}"
                said = _said(history)
                if said and status == WorkerStatus.COMPLETE:
                    break
                if status in (WorkerStatus.ERROR, WorkerStatus.INTERRUPTED, WorkerStatus.INACTIVE, WorkerStatus.API_TIMEOUT):
                    return False, f"turn failed: status={status}"
            await asyncio.sleep(2.0)
        if said and status == WorkerStatus.COMPLETE:
            evidence = await _source_evidence(fresh, model)
            return EXPECTED in said.lower(), f"{evidence} answer={said.strip()[:160]}"
        # No answer is never self-explanatory: say what state the turn was left in.
        kinds = [(item.attributes or {}).get("element-type") for item in history]
        return False, f"no answer: status={status} session={process.session_id} history={kinds}"
    except Exception as exc:  # noqa: BLE001 -- a cell's failure is a row in the table, not a crash
        return False, f"{type(exc).__name__}: {exc}"[:300]
    finally:
        await process.exit()


async def main() -> int:
    if sys.argv[1:2] == ["--verify-cli"]:
        if len(sys.argv) != 4:
            print("usage: worker_matrix.py --verify-cli PROCESS_ID MODEL", file=sys.stderr)
            return 2
        print(await verify_cli_turn(sys.argv[2], sys.argv[3]))
        return 0
    try:
        workers = selected_workers(sys.argv[1:])
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    failed = 0
    for worker_type, binary, spelling in workers:
        if shutil.which(binary) is None:
            for slug in MODELS:
                print(f"FAIL  {worker_type.value:11} {slug:38} BLOCKED: CLI {binary} not installed", flush=True)
                failed += 1
            continue
        for slug in MODELS:
            started = time.monotonic()
            ok, detail = await _turn(worker_type, spelling.format(slug=slug))
            failed += 0 if ok else 1
            print(
                f"{'PASS' if ok else 'FAIL'}  {worker_type.value:11} {slug:38} {time.monotonic() - started:5.0f}s  {detail}",
                flush=True,
            )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
