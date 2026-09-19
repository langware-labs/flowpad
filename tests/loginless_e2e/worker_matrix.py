"""Every harness x a few cheap non-vendor models, on a machine that never logged in.

Run AFTER ``flow llm user use <public-endpoint-id>``. One print-mode turn per cell; a cell passes
when the assistant's own words contain the expected one. Prints a table and exits non-zero if any
cell failed, so a container run is its own verdict.

    python worker_matrix.py                      # all installed harnesses x MODELS
    python worker_matrix.py claude codex         # only these harnesses
"""

import asyncio
import shutil
import sys
import tempfile
import time

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.status_predicates import is_turn_busy
from flow_sdk.flowpad_types.enums import WorkerType

PROMPT = 'Reply with exactly the single word "pong" and nothing else.'
EXPECTED = "pong"
#: The same bound ``tests/long_tests/test_llm_endpoint_workers.py`` gives one turn.
TURN_DEADLINE_S = 240.0

#: OpenRouter slugs. All three are in the hub's price table -- a public endpoint carries a cost
#: limit, and the hub refuses a model it cannot price where a cost limit could not meter it.
MODELS = ["moonshotai/kimi-k2.5", "z-ai/glm-4.7-flash", "qwen/qwen3-coder-30b-a3b-instruct"]

#: ``(worker, binary, how that CLI spells an OpenRouter slug)`` -- opencode namespaces by provider.
WORKERS = [
    (WorkerType.CLAUDE_CODE, "claude", "{slug}"),
    (WorkerType.CODEX, "codex", "{slug}"),
    (WorkerType.COPILOT, "copilot", "{slug}"),
    (WorkerType.OPENCODE, "opencode", "openrouter/{slug}"),
]


def _said(history: list) -> str:
    """Everything the assistant SAID -- its ``chat`` elements, never the prompt or its reasoning."""
    return " ".join(
        str(item.flow_value)
        for item in history
        if (item.attributes or {}).get("role") == "assistant" and (item.attributes or {}).get("element-type") == "chat"
    )


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
                said = _said(history)
                if said:
                    break
            await asyncio.sleep(2.0)
        if said:
            return EXPECTED in said.lower(), said.strip()[:160]
        # No answer is never self-explanatory: say what state the turn was left in.
        kinds = [(item.attributes or {}).get("element-type") for item in history]
        return False, f"no answer: status={status} session={process.session_id} history={kinds}"
    except Exception as exc:  # noqa: BLE001 -- a cell's failure is a row in the table, not a crash
        return False, f"{type(exc).__name__}: {exc}"[:300]
    finally:
        await process.exit()


async def main() -> int:
    only = set(sys.argv[1:])
    failed = 0
    for worker_type, binary, spelling in WORKERS:
        if only and binary not in only:
            continue
        if shutil.which(binary) is None:
            print(f"SKIP  {binary:9} (CLI not installed)", flush=True)
            continue
        for slug in MODELS:
            started = time.monotonic()
            ok, detail = await _turn(worker_type, spelling.format(slug=slug))
            failed += 0 if ok else 1
            print(
                f"{'PASS' if ok else 'FAIL'}  {binary:9} {slug:38} {time.monotonic() - started:5.0f}s  {detail}",
                flush=True,
            )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
