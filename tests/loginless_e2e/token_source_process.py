"""Real Python SDK source proof on an isolated token-sources-* instance.

Run: TOKEN_SOURCE_CASES=/path/to/nonsecret-manifest.json python -m tests.loginless_e2e.token_source_process
The manifest schema matches ui/tests/long_tests/token-source-process.test.ts.
Use the instance storage/encryption environment that owns the local source rows.
"""

import asyncio
import json
import os
import re
import tempfile
import time
from pathlib import Path

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.status_predicates import is_turn_busy
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.transcript_analyzer.worker_status import WorkerStatus
from tests.loginless_e2e.worker_matrix import TURN_DEADLINE_S, _said, terminal_error

PROMPT = "Reply with only the digit that equals seven minus four. Do not use tools."


async def check(cell: dict) -> dict:
    process = await AgenticProcess(
        worker_type=WorkerType(cell["worker"]),
        workdir=tempfile.mkdtemp(prefix="token-source-python-"),
        cli_config={
            **({"model": cell["model"]} if cell["model"] is not None else {}),
            "permission_mode": "bypassPermissions",
        },
        pty_mode=False,
        visible=False,
        llm_endpoint_public=cell.get("public", False),
        load_flowpad_assistant=False,
    ).save()
    evidence = {"entry": "python", "case": cell["name"], "process": process.id}
    try:
        await process.set_llm_endpoint(cell["endpoint"])
        result = await process.prompt(PROMPT)
        if getattr(result, "status", None) == "FAIL":
            raise AssertionError("prompt refused")
        deadline = time.monotonic() + TURN_DEADLINE_S
        answer, status = "", None
        while time.monotonic() < deadline:
            fresh = await AgenticProcess.get_by_id(process.id) or process
            status = fresh.fetch_worker_status()
            if not is_turn_busy(fresh, status):
                history = fresh.driver.load_history(fresh) or []
                failure = terminal_error(history)
                if failure:
                    evidence["cause"] = failure
                    raise AssertionError("worker transcript contains a terminal error")
                answer = _said(history).strip()
                if status == WorkerStatus.COMPLETE and answer:
                    break
                if status in (
                    WorkerStatus.ERROR,
                    WorkerStatus.INTERRUPTED,
                    WorkerStatus.INACTIVE,
                    WorkerStatus.API_TIMEOUT,
                ):
                    evidence["cause"] = {"kind": "worker_status", "status": status.value}
                    raise AssertionError("turn did not complete successfully")
            await asyncio.sleep(2.0)  # Existing worker_matrix polling cadence, unchanged.
        assert status == WorkerStatus.COMPLETE, "turn deadline expired"
        assert re.fullmatch(r"3[.!]?", answer), "assistant answer did not match"
        assert not fresh.launch_failure, "launch failure was recorded"
        assert fresh.resolved_llm_endpoint_typeid == cell["endpoint"], "wrong or unproven source"
        assert fresh.resolved_model_slug == cell["resolvedModel"], "wrong or unproven model"
        if cell["model"] is None:
            assert not fresh.cli_config.get("model"), "derived default was persisted as an explicit model"
        evidence.update(
            endpoint=fresh.resolved_llm_endpoint_typeid,
            requestedModel=cell["model"],
            model=fresh.resolved_model_slug,
            answer=answer,
            status=status.value,
            outcome="PASS",
        )
    except Exception as exc:
        # No arbitrary provider exception text, environment or credential diagnostics.
        evidence.update(outcome="FAIL", error=type(exc).__name__)
        if isinstance(exc, AssertionError):
            evidence["reason"] = str(exc)
    finally:
        await process.exit()
    return evidence


async def main() -> int:
    if not os.environ.get("FLOW_INSTANCE", "").startswith("token-sources-"):
        raise ValueError("Select a disposable token-sources-* instance")
    manifest = os.environ.get("TOKEN_SOURCE_CASES")
    if not manifest:
        raise ValueError("TOKEN_SOURCE_CASES is required")
    cells = json.loads(Path(manifest).read_text())
    if not isinstance(cells, list) or not cells:
        raise ValueError("Required source matrix is empty")
    for cell in cells:
        if (
            not isinstance(cell, dict)
            or any(not cell.get(k) for k in ("name", "worker", "endpoint"))
            or "model" not in cell
            or (cell["model"] is not None and not isinstance(cell["model"], str))
            or (cell["model"] == "" and cell.get("kind") != "device")
            or cell.get("kind") not in ("device", "api_key", "hub")
            or "resolvedModel" not in cell
        ):
            raise ValueError("Invalid token source matrix cell")
        WorkerType(cell["worker"])
    failed = 0
    for cell in cells:
        evidence = await check(cell)
        print(json.dumps(evidence), flush=True)
        failed += evidence["outcome"] != "PASS"
    return int(bool(failed))


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
