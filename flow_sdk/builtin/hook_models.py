"""Shared models for hook and trigger functionality.

This module contains models used by both AgentHook and Trigger
to avoid circular imports.
"""

import asyncio
import inspect
import logging
import os
import stat
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from flow_sdk._compat import StrEnum
from typing import Any, Optional

from pydantic import BaseModel

from flow_sdk.builtin.change_event import ChangeEvent

_log = logging.getLogger(__name__)

_DEFAULT_SCRIPT_TIMEOUT_S = 30.0
# Bytes captured from stdout/stderr — bounded so TriggerLogRecord stays small.
_SCRIPT_OUTPUT_CAP = 8192


@dataclass
class RunResult:
    """Result of executing a RUN_SCRIPT action."""

    stdout: str
    stderr: str
    returncode: Optional[int]
    duration_ms: int
    timed_out: bool
    script_path: Optional[str] = None  # which path actually ran (after resolution)


class ActionType(StrEnum):
    """Types of actions that can be triggered."""

    NOP = "nop"
    NOTIFY_ENTITY = "notify_entity"
    RUN_SCRIPT = "run_script"
    CALLBACK = "callback"


class RelationshipSubAction(StrEnum):
    """Sub-actions for relationship operations."""

    ADD = "add"
    REMOVE = "remove"


class ErrorMessage(StrEnum):
    """Common error messages for API responses."""

    REQUEST_INFO_NOT_AVAILABLE = "Request info not available"
    REQUEST_BODY_REQUIRED = "Request body is required"
    AGENT_HOOK_ID_REQUIRED = "agent_hook_id is required in request body"
    TRIGGER_ID_REQUIRED = "trigger_id is required in request body"
    INVALID_AGENT_HOOK_ID_FORMAT = "Invalid agent_hook_id format"
    INVALID_TRIGGER_ID_FORMAT = "Invalid trigger_id format"
    UNKNOWN_SUB_ACTION = "Unknown sub-action"
    METHOD_NOT_ALLOWED = "Method not allowed for action"


class SuccessMessage(StrEnum):
    """Common success messages for API responses."""

    AGENT_HOOK_CONNECTED = "Agent hook connected successfully"
    AGENT_HOOK_DISCONNECTED = "Agent hook disconnected successfully"
    TRIGGER_CONNECTED = "Trigger connected successfully"
    TRIGGER_DISCONNECTED = "Trigger disconnected successfully"


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


class ExecutedAction(BaseModel):
    """Result of executing a trigger action."""

    trigger_id: str
    trigger_name: str
    action_type: ActionType
    counter: int


# Re-export canonical HookEventData from shared module
from flow_sdk.claude_hook_events.hook_event_data import HookEventData


class WebhookHandleResult(BaseModel):
    """Result of handling an agent hook webhook."""

    status: str
    matched_triggers: int
    executed_actions: list[Any]
    agentic_process_id: Optional[str] = None
    flow_id: Optional[str] = None
    session_id: Optional[str] = None


class TriggerActionHandler(ABC):
    """Base class for trigger action handlers.

    All handlers receive a `changes: list[ChangeEvent]`. Schedule/hook fires
    pass an empty list; FSOp fires pass 1..N events per debounce window.
    """

    @abstractmethod
    async def execute(
        self,
        trigger: Any,
        action: Optional["TriggerAction"] = None,
        changes: Optional[list["ChangeEvent"]] = None,
    ) -> None:
        """Execute the action on the trigger."""
        pass


class NopActionHandler(TriggerActionHandler):
    """Handler for NOP action - does nothing."""

    async def execute(self, trigger: Any, action: Optional["TriggerAction"] = None, changes: Optional[list["ChangeEvent"]] = None) -> None:
        pass


class NotifyEntityActionHandler(TriggerActionHandler):
    """Handler for NOTIFY_ENTITY action — bumps trigger.counter by 1 ONLY when
    invoked from a context that didn't already count (i.e. HOOK triggers via
    `Trigger.execute_action`, which calls `handler.execute(self)` with no
    `changes` kwarg). FSOp `_fire` and Schedule `_fire_schedule_job` both pass
    an explicit `changes` list (possibly empty) AND already incremented the
    counter themselves — double-counting them was a pre-existing bug that the
    batch refactor would have amplified to `2 * len(changes)`.
    """

    async def execute(self, trigger: Any, action: Optional["TriggerAction"] = None, changes: Optional[list["ChangeEvent"]] = None) -> None:
        if changes is None:
            trigger.counter += 1


class CallbackActionHandler(TriggerActionHandler):
    """Handler for CALLBACK action — dispatches to a Python handler registered
    via `@trigger_callbacks.register(name)`.

    Invokes `cb(trigger, changes)`. Sync handlers are called directly; async
    handlers are awaited. Missing callback name → warning logged, no crash.
    Exceptions raised by the user's handler propagate out — the fire-loop is
    responsible for isolating them and continuing to the next action.
    """

    async def execute(
        self,
        trigger: Any,
        action: Optional["TriggerAction"] = None,
        changes: Optional[list["ChangeEvent"]] = None,
    ) -> None:
        if action is None or action.callback_name is None:
            _log.warning("CALLBACK action on %s has no callback_name", getattr(trigger, "name", "?"))
            return
        from flow_sdk.builtin import trigger_callbacks  # avoid circular import at module load

        cb = trigger_callbacks.get(action.callback_name)
        if cb is None:
            _log.warning(
                "CALLBACK on %s: no handler registered for name %r",
                getattr(trigger, "name", "?"),
                action.callback_name,
            )
            return
        result = cb(trigger, changes or [])
        if inspect.isawaitable(result):
            await result


def _ensure_executable(path: Path) -> None:
    """chmod +x (owner/group/other); idempotent — skips when any exec bit is set."""
    mode = path.stat().st_mode
    if mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH):
        return
    path.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


async def _exec_script(
    script_path: Path,
    trigger: Any,
    changes: Optional[list["ChangeEvent"]],
    timeout_seconds: float = _DEFAULT_SCRIPT_TIMEOUT_S,
) -> RunResult:
    """Run an external script via asyncio.create_subprocess_exec.

    Env vars: TRIGGER_ID / TRIGGER_NAME / CHANGES_COUNT / FIRST_CHANGED_PATH /
    FIRST_CHANGE_TYPE for quick access; the full batch is serialized to a
    tempfile (cross-platform via tempfile.NamedTemporaryFile) and its path
    passed via CHANGES_JSON_PATH so scripts that need the batch can read it.

    Captures stdout/stderr (truncated to _SCRIPT_OUTPUT_CAP). Kills the
    process at `timeout_seconds`. Cleans up the tempfile after the subprocess.
    """
    import json
    import tempfile

    changes = changes or []
    first = changes[0] if changes else None
    payload = [{"path": str(c.path), "change_type": c.change_type} for c in changes]

    # Captured up-front so the outer finally can clean up even if
    # tempfile setup or json.dump/flush raises midway.
    changes_json_path: str | None = None
    try:
        tmp = tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        )
        # tmp.name is valid as soon as NamedTemporaryFile returns; capture it
        # before the dump so a json.dump / flush failure still hits cleanup.
        changes_json_path = tmp.name
        try:
            json.dump(payload, tmp)
            tmp.flush()
        finally:
            tmp.close()

        env = {
            **os.environ,
            "TRIGGER_ID": str(getattr(trigger, "id", "")),
            "TRIGGER_NAME": str(getattr(trigger, "name", "")),
            "CHANGES_COUNT": str(len(changes)),
            "FIRST_CHANGED_PATH": str(first.path) if first else "",
            "FIRST_CHANGE_TYPE": first.change_type if first else "",
            "CHANGES_JSON_PATH": changes_json_path,
        }
        proc = await asyncio.create_subprocess_exec(
            str(script_path),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(Path(script_path).parent),
        )
        t0 = time.monotonic()
        timed_out = False
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_seconds)
        except asyncio.TimeoutError:
            proc.kill()
            timed_out = True
            try:
                stdout, stderr = await proc.communicate()
            except Exception:
                stdout, stderr = b"", b""
        duration_ms = int((time.monotonic() - t0) * 1000)
        return RunResult(
            stdout=stdout.decode(errors="replace")[:_SCRIPT_OUTPUT_CAP] if stdout else "",
            stderr=stderr.decode(errors="replace")[:_SCRIPT_OUTPUT_CAP] if stderr else "",
            returncode=proc.returncode,
            duration_ms=duration_ms,
            timed_out=timed_out,
            script_path=str(script_path),
        )
    finally:
        if changes_json_path is not None:
            try:
                os.unlink(changes_json_path)
            except OSError:
                pass


class RunScriptActionHandler(TriggerActionHandler):
    """Subprocess-execute a script. Source order: external `action.script_path` →
    embedded `trigger.data_dir / action.script_filename` → warn + no-op.

    One subprocess per fire (i.e. per debounce batch), not per event. The full
    batch is delivered via CHANGES_JSON_PATH; FIRST_* env vars give quick access
    to the head of the batch for simple scripts.
    """

    async def execute(
        self,
        trigger: Any,
        action: Optional["TriggerAction"] = None,
        changes: Optional[list["ChangeEvent"]] = None,
        timeout_seconds: float = _DEFAULT_SCRIPT_TIMEOUT_S,
    ) -> Optional[RunResult]:
        if action is None:
            _log.warning("RUN_SCRIPT on %s: no action supplied", getattr(trigger, "name", "?"))
            return None

        # Resolution mode 1: external script path (preferred if it exists on disk).
        if action.script_path:
            ext = Path(action.script_path)
            if ext.exists():
                return await _exec_script(
                    ext, trigger, changes, timeout_seconds=timeout_seconds
                )
            # External path was set but file is missing — fall through to embedded.

        # Resolution mode 2: embedded script in trigger's data folder.
        if action.script_filename:
            data_dir = getattr(trigger, "data_dir", None)
            if data_dir is None:
                _log.warning(
                    "RUN_SCRIPT on %s: script_filename set but trigger has no data_dir",
                    getattr(trigger, "name", "?"),
                )
                return None
            embedded = Path(data_dir) / action.script_filename
            if not embedded.exists():
                _log.warning(
                    "RUN_SCRIPT on %s: embedded script %s does not exist in %s",
                    getattr(trigger, "name", "?"),
                    action.script_filename,
                    data_dir,
                )
                return None
            # Ensure +x before exec (embedded files won't have it from write_file).
            _ensure_executable(embedded)
            return await _exec_script(
                embedded, trigger, changes, timeout_seconds=timeout_seconds
            )

        _log.warning(
            "RUN_SCRIPT on %s: no script_path on disk and no script_filename",
            getattr(trigger, "name", "?"),
        )
        return None


_ACTION_HANDLERS: dict[ActionType, TriggerActionHandler] = {
    ActionType.NOP: NopActionHandler(),
    ActionType.NOTIFY_ENTITY: NotifyEntityActionHandler(),
    ActionType.RUN_SCRIPT: RunScriptActionHandler(),
    ActionType.CALLBACK: CallbackActionHandler(),
}


def get_action_handler(action_type: ActionType) -> TriggerActionHandler | None:
    """Get the handler for an action type."""
    return _ACTION_HANDLERS.get(action_type)
