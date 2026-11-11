"""Ask a headless agent one question, on a machine that has never logged in to anything.

The whole setup is the command before this one -- ``flow llm user use <public-endpoint-id>`` --
which points the box at a PUBLIC hub ``LLMEndpoint``. Nothing here names a budget, a key or a
hub: the process is funded by whatever the box resolves, exactly as on a signed-in machine.
"""

import asyncio
import tempfile

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.status_predicates import is_turn_busy
from flow_sdk.flowpad_types.enums import WorkerType

PROMPT = 'Reply with exactly the single word "pong" and nothing else.'


async def main() -> None:
    process = await AgenticProcess(
        worker_type=WorkerType.CLAUDE_CODE,
        workdir=tempfile.mkdtemp(),
        cli_config={"model": "sm", "permission_mode": "bypassPermissions"},
        pty_mode=False,  # print mode: one spawn, one turn, then done
        visible=False,
        load_flowpad_assistant=False,
    ).save()
    try:
        await process.prompt(PROMPT)
        # ``prompt()`` returning is the turn STARTING. The answer is in the history once the
        # turn is no longer busy.
        while True:
            fresh = await AgenticProcess.get_by_id(process.id) or process
            if not is_turn_busy(fresh, fresh.fetch_worker_status()):
                history = fresh.driver.load_history(fresh)
                if history:
                    break
            await asyncio.sleep(2.0)
        print(_last_answer(history))
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
