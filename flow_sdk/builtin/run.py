"""Run entity — one Approve & Execute (or analogous "kick a prompt") invocation.

Runs are turn-grained: every approve creates a new Run row, status flips
``running → stopped|failed`` in the headless pipeline's ``finally`` block.
The underlying ``AgenticProcess`` is reused across Runs to preserve Claude
session continuity — the Run's ``process_id`` points at it so the Runs
drawer's terminal-icon click can attach to the same shared session.

Field model:
  * ``target_typeid_str`` mirrors the value the AgenticProcess carries, so the
    same drawer query (by target) lists every Run for a Task / Conversation /
    other anchor entity.
  * ``process_id`` is the FK that lets the row open a terminal on the actual
    process; multiple Run rows for the same target collapse to one terminal.
  * ``draft_flow_message_id`` ties a finished Run to the draft FlowMessage it
    produced (when it produced text). Empty when the run errored or the
    assistant emitted no CHAT output.
  * ``source_flow_message_id`` records the FlowMessage whose PROMPT attachment
    triggered this Run (the message the user clicked Approve on). Lets the
    Runs drawer filter per-message instead of showing every Run on the task.
"""
from __future__ import annotations

from typing import ClassVar, Optional

from flow_sdk._compat import StrEnum
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity


class RunStatus(StrEnum):
    RUNNING = "running"
    STOPPED = "stopped"
    FAILED = "failed"


class Run(Entity):
    type: str = APIField(default="run")
    target_typeid_str: str = APIField("")
    process_id: str = APIField("")
    prompt_text: str = APIField("")
    status: str = APIField(default=RunStatus.RUNNING)
    started_at: Optional[str] = APIField(None)
    ended_at: Optional[str] = APIField(None)
    draft_flow_message_id: Optional[str] = APIField(None)
    source_flow_message_id: Optional[str] = APIField(None)
    _api_visible: ClassVar[bool] = True
    _icon: ClassVar[str] = "Play"
