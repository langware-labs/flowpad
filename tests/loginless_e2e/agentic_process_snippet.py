"""Ask a headless agent one question, on a machine that has never logged in to anything.

The whole setup is the command before this one -- ``flow llm user use <public-endpoint-id>`` --
which points the box at a PUBLIC hub ``LLMEndpoint``. Nothing here names a budget, a key or a
hub: the process is funded by whatever the box resolves, exactly as on a signed-in machine.
"""

import asyncio
import os
import tempfile

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.status_predicates import is_turn_busy
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.instance_settings.llm_endpoint import get_hub_llm_endpoint
from flow_sdk.transcript_analyzer.worker_status import WorkerStatus

PROMPT = 'Reply with exactly the single word "pong" and nothing else.'


async def main() -> None:
    process = await AgenticProcess(
        worker_type=WorkerType.CLAUDE_CODE,
        workdir=tempfile.mkdtemp(),
        # A public endpoint publishes no size map to an anonymous box (FLOWPAD-2318 refuses an asked size the budget
        # does not declare), so LOGINLESS_MODEL may name the model the endpoint serves; default stays the size.
        cli_config={"model": os.environ.get("LOGINLESS_MODEL") or "sm", "permission_mode": "bypassPermissions"},
        pty_mode=False,  # print mode: one spawn, one turn, then done
        visible=False,
        load_flowpad_assistant=False,
    ).save()
    try:
        result = await process.prompt(PROMPT)
        if getattr(result, "status", None) == "FAIL":
            raise RuntimeError("prompt was refused")
        # ``prompt()`` returning is the turn STARTING. The answer is in the history once the
        # turn is no longer busy.
        while True:
            fresh = await AgenticProcess.get_by_id(process.id) or process
            status = fresh.fetch_worker_status()
            if not is_turn_busy(fresh, status):
                if status in (WorkerStatus.ERROR, WorkerStatus.INTERRUPTED, WorkerStatus.INACTIVE, WorkerStatus.API_TIMEOUT):
                    raise RuntimeError(f"turn did not succeed: {status}")
                history = fresh.driver.load_history(fresh)
                if status == WorkerStatus.COMPLETE:
                    if not _last_answer(history or []):
                        raise RuntimeError("completed turn has no assistant answer")
                    break
            await asyncio.sleep(2.0)
        bound = get_hub_llm_endpoint()
        actual_source = fresh.resolved_llm_endpoint_typeid
        if not actual_source or (bound is not None and actual_source != bound.endpoint_typeid):
            raise RuntimeError("turn used a different or unproven endpoint")
        answer = _last_answer(history)
        if "pong" not in answer.lower():
            raise RuntimeError("assistant did not supply the expected answer")
        print(answer)
    finally:
        await process.exit()


def _last_answer(history: list) -> str:
    """The last thing the assistant SAID -- its ``chat`` elements, not its reasoning."""
    for item in reversed(history):
        attributes = item.attributes or {}
        if attributes.get("role") == "assistant" and attributes.get("element-type") == "chat":
            return str(item.flow_value).strip()
    return ""


if __name__ == "__main__":
    asyncio.run(main())
