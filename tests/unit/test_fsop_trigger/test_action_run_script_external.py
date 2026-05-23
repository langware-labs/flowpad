"""Step 5: RunScriptActionHandler (external script path) + _exec_script.

Tests the external-path mode of RUN_SCRIPT. Embedded mode is step 6.
"""
from __future__ import annotations

import os
import stat
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from flow_sdk.builtin.change_event import ChangeEvent
from flow_sdk.builtin.hook_models import (
    ActionType,
    RunScriptActionHandler,
    TriggerAction,
    get_action_handler,
)


# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


def _make_fake_trigger(name: str = "t", trigger_id: str = "test-id-001") -> MagicMock:
    t = MagicMock()
    t.name = name
    t.id = trigger_id
    return t


def _changes(path: str = "/tmp/x", change_type: str = "modified") -> list[ChangeEvent]:
    return [ChangeEvent(path=Path(path), change_type=change_type)]


def _make_script(tmp_path: Path, name: str, body: str) -> Path:
    """Write `body` to `tmp_path/name`, chmod +x, return the path."""
    p = tmp_path / name
    p.write_text(body)
    p.chmod(p.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return p


async def test_get_action_handler_returns_run_script_handler():
    handler = get_action_handler(ActionType.RUN_SCRIPT)
    assert isinstance(handler, RunScriptActionHandler)


async def test_external_path_executes(tmp_path):
    """Script writes a marker file; verify it exists after dispatch."""
    marker = tmp_path / "marker.txt"
    script = _make_script(tmp_path, "s.sh", f"#!/usr/bin/env bash\ntouch {marker}\n")

    handler = RunScriptActionHandler()
    action = TriggerAction(action_type=ActionType.RUN_SCRIPT, script_path=str(script))
    await handler.execute(_make_fake_trigger(), action=action, changes=_changes("/tmp/x", "modified"))

    assert marker.exists(), "script should have created marker file"


async def test_external_path_stdout_captured(tmp_path):
    """Run result must capture stdout."""
    script = _make_script(tmp_path, "s.sh", '#!/usr/bin/env bash\necho hello-stdout\n')

    handler = RunScriptActionHandler()
    action = TriggerAction(action_type=ActionType.RUN_SCRIPT, script_path=str(script))
    result = await handler.execute(_make_fake_trigger(), action=action, changes=_changes("/tmp/x", "modified"))

    assert result is not None, "handler must return a RunResult"
    assert "hello-stdout" in result.stdout


async def test_external_path_stderr_captured(tmp_path):
    script = _make_script(tmp_path, "s.sh", '#!/usr/bin/env bash\necho oops 1>&2\n')

    handler = RunScriptActionHandler()
    action = TriggerAction(action_type=ActionType.RUN_SCRIPT, script_path=str(script))
    result = await handler.execute(_make_fake_trigger(), action=action, changes=_changes("/tmp/x", "modified"))
    assert "oops" in result.stderr


async def test_external_path_returncode_zero_on_success(tmp_path):
    script = _make_script(tmp_path, "s.sh", '#!/usr/bin/env bash\nexit 0\n')

    handler = RunScriptActionHandler()
    action = TriggerAction(action_type=ActionType.RUN_SCRIPT, script_path=str(script))
    result = await handler.execute(_make_fake_trigger(), action=action, changes=_changes("/tmp/x", "modified"))
    assert result.returncode == 0
    assert result.timed_out is False


async def test_external_path_returncode_nonzero(tmp_path):
    script = _make_script(tmp_path, "s.sh", '#!/usr/bin/env bash\nexit 7\n')

    handler = RunScriptActionHandler()
    action = TriggerAction(action_type=ActionType.RUN_SCRIPT, script_path=str(script))
    result = await handler.execute(_make_fake_trigger(), action=action, changes=_changes("/tmp/x", "modified"))
    assert result.returncode == 7


async def test_external_path_env_vars_set(tmp_path):
    """Script receives TRIGGER_ID, TRIGGER_NAME, CHANGES_COUNT, FIRST_CHANGED_PATH,
    FIRST_CHANGE_TYPE, CHANGES_JSON_PATH env vars."""
    out = tmp_path / "env.txt"
    script = _make_script(
        tmp_path,
        "s.sh",
        f"#!/usr/bin/env bash\necho id=$TRIGGER_ID > {out}\necho name=$TRIGGER_NAME >> {out}\necho count=$CHANGES_COUNT >> {out}\necho path=$FIRST_CHANGED_PATH >> {out}\necho type=$FIRST_CHANGE_TYPE >> {out}\necho json=$CHANGES_JSON_PATH >> {out}\n",
    )

    handler = RunScriptActionHandler()
    action = TriggerAction(action_type=ActionType.RUN_SCRIPT, script_path=str(script))
    await handler.execute(
        _make_fake_trigger(name="my_trigger", trigger_id="abc-123"),
        action=action,
        changes=_changes("/path/to/file", "modified"),
    )

    contents = out.read_text()
    assert "id=abc-123" in contents
    assert "name=my_trigger" in contents
    assert "count=1" in contents
    assert "path=/path/to/file" in contents
    assert "type=modified" in contents
    # CHANGES_JSON_PATH is set to a tempfile path; just check it's non-empty.
    json_line = next(ln for ln in contents.splitlines() if ln.startswith("json="))
    assert len(json_line) > len("json=")


async def test_external_path_missing_logs_warning_no_crash(caplog, tmp_path):
    """script_path set but file doesn't exist on disk; in step 5 (no embedded fallback yet)
    this logs a warning, doesn't crash, returns None or an empty/sentinel result."""
    handler = RunScriptActionHandler()
    action = TriggerAction(action_type=ActionType.RUN_SCRIPT, script_path=str(tmp_path / "missing.sh"))
    # Should not raise
    await handler.execute(_make_fake_trigger(), action=action, changes=_changes("/x", "modified"))


async def test_external_path_short_timeout_killed(tmp_path):
    """A script that runs longer than the configured timeout is killed; result has timed_out=True."""
    script = _make_script(tmp_path, "s.sh", '#!/usr/bin/env bash\nsleep 10\n')

    handler = RunScriptActionHandler()
    action = TriggerAction(action_type=ActionType.RUN_SCRIPT, script_path=str(script))
    # Use a short timeout via handler override for the test (not the default 30s)
    result = await handler.execute(
        _make_fake_trigger(),
        action=action,
        changes=_changes("/x", "modified"),
        timeout_seconds=1.0,
    )
    assert result.timed_out is True
    assert result.returncode != 0  # killed → negative or non-zero


async def test_external_path_duration_recorded(tmp_path):
    """RunResult includes a duration_ms field."""
    script = _make_script(tmp_path, "s.sh", '#!/usr/bin/env bash\nexit 0\n')
    handler = RunScriptActionHandler()
    action = TriggerAction(action_type=ActionType.RUN_SCRIPT, script_path=str(script))
    result = await handler.execute(_make_fake_trigger(), action=action, changes=_changes("/x", "modified"))
    assert result.duration_ms >= 0
