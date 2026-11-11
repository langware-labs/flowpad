"""Existing trigger effects, called individually by compiled wizard operations.

These helpers own neither sequencing nor outcome routing. The wizard chooses
when to accept a fire and when to launch its legacy instruction.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING

from flow_sdk.schema.data_spec.returned_value_spec import PromptResult

if TYPE_CHECKING:
    from flow_sdk.builtin.change_event import ChangeEvent
    from flow_sdk.builtin.trigger import Trigger


async def accept_schedule(trigger: Trigger) -> None:
    from flow_sdk.builtin.trigger import _scheduled_next_run

    trigger.counter += 1
    trigger.last_run = datetime.now(timezone.utc)
    trigger.next_run = _scheduled_next_run(trigger.id)
    await trigger.update()


async def accept_file(trigger: Trigger, changes: list[ChangeEvent]) -> None:
    trigger.counter += len(changes)
    trigger.last_triggered = datetime.now(timezone.utc)
    if trigger.watch_path:
        for change in reversed(changes):
            if str(change.path) != trigger.watch_path:
                continue
            try:
                stat = change.path.stat()
                trigger.last_seen_mtime = stat.st_mtime
                trigger.last_seen_size = stat.st_size
            except FileNotFoundError:
                trigger.last_seen_mtime = None
                trigger.last_seen_size = None
            break
    if trigger.id:
        await trigger.update()


async def accept_hook(trigger: Trigger) -> None:
    trigger.last_triggered = datetime.now(timezone.utc)
    await trigger.update()


async def run_instruction(trigger: Trigger) -> PromptResult:
    """Launch the old schedule prompt; the answer is admission, not task output."""
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

    process = AgenticProcess(
        instruction_content=trigger.instruction,
        workdir=trigger.workdir,
        target_typeid_str=str(trigger.typeid),
        project_id=trigger.project_id,
        visible=False,
        name=f"Trigger: {trigger.name}" if trigger.name else "Trigger",
    )
    await process.save()
    await process.start_pty(instruction=trigger.instruction, visible=False)
    return PromptResult.satisfied(
        "The instruction was launched.", executor=str(process.typeid), value_present=False,
    )
