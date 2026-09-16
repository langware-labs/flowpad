"""Filesystem contracts independent of application entities."""
from typing import Optional

from pydantic import BaseModel

from flow_sdk._compat import StrEnum


class ActionType(StrEnum):
    """Types of actions that can be triggered."""

    NOP = "nop"
    NOTIFY_ENTITY = "notify_entity"
    RUN_SCRIPT = "run_script"
    CALLBACK = "callback"
    RUN_AGENT = "run_agent"


class TriggerAction(BaseModel):
    """Action to be executed when a trigger matches."""

    action_type: ActionType
    # RUN_SCRIPT delivery: external script path on disk (preferred if it exists).
    script_path: Optional[str] = None
    # RUN_SCRIPT delivery: filename inside the trigger record's data folder
    # (`record.data_dir / script_filename`). Used when `script_path` is None or
    # the file doesn't exist on disk. Editable via flowpad's file editor.
    script_filename: Optional[str] = None
    # CALLBACK delivery: name registered via `@trigger_callbacks.register("name")`.
    callback_name: Optional[str] = None
    # WHAT the action acts on, as a TypeId (`wizard-<uuid>`).
    #
    # A callback used to name only a Python function, so "run a wizard" had to
    # carry its subject on the TRIGGER's generic `path` — a field a HOOK trigger
    # uses for its record.json, and which is Sharing.PRIVATE, so a shared trigger
    # lost its target entirely. An action that cannot say what it acts on cannot
    # be validated, cannot be searched for, and reads as "callback" in the UI.
    target_type_id: Optional[str] = None
    # RUN_AGENT delivery: the prompt the agent runs with.
    prompt: Optional[str] = None
