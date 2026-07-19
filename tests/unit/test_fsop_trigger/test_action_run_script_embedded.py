"""Step 6: RunScriptActionHandler embedded mode (script in trigger record's data folder).

When `action.script_path` is missing/doesn't-exist, fall back to
`trigger.data_dir / action.script_filename`. This is the "open by editor" mode —
the script body lives inside the trigger's data folder, user-editable.
"""
from __future__ import annotations

import stat
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from flow_sdk.builtin.change_event import ChangeEvent
from flow_sdk.builtin.hook_models import (
    ActionType,
    RunScriptActionHandler,
    TriggerAction,
)
from flow_sdk.builtin.trigger import Trigger, TriggerType


# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


def _changes(path: str = "/tmp/x", change_type: str = "modified") -> list[ChangeEvent]:
    return [ChangeEvent(path=Path(path), change_type=change_type)]


@pytest.fixture
def records_data_root(tmp_path, monkeypatch):
    """Redirect records_data root to a temp dir so we don't pollute the real ~/.flow."""
    from flow_sdk.fs_store import record_paths as record_paths_module

    root = tmp_path / "records_data"
    root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(record_paths_module, "get_default_records_data_root", lambda: root)
    return root


def _make_trigger_with_data(record_root: Path, trigger_id: str = "abc-123") -> Trigger:
    """Build a Trigger whose data_dir lives under record_root."""
    t = Trigger(name="t", trigger_type=TriggerType.FSOP, watch_path="/tmp/x")
    t.id = trigger_id
    return t


async def test_trigger_has_data_dir_property(records_data_root):
    t = _make_trigger_with_data(records_data_root)
    expected = records_data_root / "trigger" / "abc-123"
    assert t.data_dir == expected


async def test_trigger_data_dir_creates_on_access(records_data_root):
    t = _make_trigger_with_data(records_data_root)
    # First access materializes the directory.
    assert t.data_dir.is_dir()


async def test_trigger_write_file_persists(records_data_root):
    t = _make_trigger_with_data(records_data_root)
    t.write_file("script.sh", "#!/bin/bash\necho hi\n")
    assert (t.data_dir / "script.sh").is_file()
    assert (t.data_dir / "script.sh").read_text() == "#!/bin/bash\necho hi\n"


async def test_trigger_read_file_returns_content(records_data_root):
    t = _make_trigger_with_data(records_data_root)
    t.write_file("note.txt", "hello world")
    assert t.read_file("note.txt") == "hello world"


async def test_trigger_read_file_missing_returns_none(records_data_root):
    t = _make_trigger_with_data(records_data_root)
    assert t.read_file("does_not_exist.txt") is None


async def test_embedded_runs_from_data_dir(records_data_root, tmp_path):
    """End-to-end: write script to data_dir; handler resolves + runs it."""
    marker = tmp_path / "marker.txt"
    t = _make_trigger_with_data(records_data_root)
    t.write_file("build.sh", f"#!/usr/bin/env bash\ntouch {marker}\n")

    handler = RunScriptActionHandler()
    action = TriggerAction(action_type=ActionType.RUN_SCRIPT, script_filename="build.sh")
    result = await handler.execute(t, action=action, changes=_changes("/x", "modified"))

    assert marker.exists(), "embedded script should have created marker"
    assert result is not None
    assert result.returncode == 0


async def test_embedded_chmod_x_applied(records_data_root):
    """The handler must mark the embedded script executable before exec."""
    t = _make_trigger_with_data(records_data_root)
    t.write_file("s.sh", "#!/usr/bin/env bash\nexit 0\n")
    # File starts without +x; embedded handler should add it
    script = t.data_dir / "s.sh"
    # Remove exec bit if it's there
    script.chmod(script.stat().st_mode & ~stat.S_IEXEC & ~stat.S_IXGRP & ~stat.S_IXOTH)

    handler = RunScriptActionHandler()
    action = TriggerAction(action_type=ActionType.RUN_SCRIPT, script_filename="s.sh")
    result = await handler.execute(t, action=action, changes=_changes("/x", "m"))
    # Should not fail with permission denied
    assert result is not None
    assert result.returncode == 0


async def test_embedded_respects_shebang(records_data_root, tmp_path):
    """Python shebang → script runs via python3."""
    marker = tmp_path / "py_marker.txt"
    t = _make_trigger_with_data(records_data_root)
    t.write_file(
        "s.py",
        f'#!/usr/bin/env python3\nopen("{marker}", "w").write("py")\n',
    )
    handler = RunScriptActionHandler()
    action = TriggerAction(action_type=ActionType.RUN_SCRIPT, script_filename="s.py")
    result = await handler.execute(t, action=action, changes=_changes("/x", "m"))
    assert result.returncode == 0
    assert marker.exists()
    assert marker.read_text() == "py"


async def test_external_path_takes_precedence_over_embedded(records_data_root, tmp_path):
    """If script_path exists on disk, use it; ignore embedded."""
    external_marker = tmp_path / "external.txt"
    embedded_marker = tmp_path / "embedded.txt"

    ext_script = tmp_path / "ext.sh"
    ext_script.write_text(f"#!/usr/bin/env bash\ntouch {external_marker}\n")
    ext_script.chmod(0o755)

    t = _make_trigger_with_data(records_data_root)
    t.write_file("emb.sh", f"#!/usr/bin/env bash\ntouch {embedded_marker}\n")

    handler = RunScriptActionHandler()
    action = TriggerAction(
        action_type=ActionType.RUN_SCRIPT,
        script_path=str(ext_script),
        script_filename="emb.sh",
    )
    await handler.execute(t, action=action, changes=_changes("/x", "m"))

    assert external_marker.exists(), "external script should run when its path exists"
    assert not embedded_marker.exists(), "embedded should be skipped when external exists"


async def test_missing_external_falls_back_to_embedded(records_data_root, tmp_path):
    """If script_path is set but doesn't exist, fall back to embedded."""
    marker = tmp_path / "embedded.txt"
    t = _make_trigger_with_data(records_data_root)
    t.write_file("emb.sh", f"#!/usr/bin/env bash\ntouch {marker}\n")

    handler = RunScriptActionHandler()
    action = TriggerAction(
        action_type=ActionType.RUN_SCRIPT,
        script_path=str(tmp_path / "does_not_exist.sh"),
        script_filename="emb.sh",
    )
    result = await handler.execute(t, action=action, changes=_changes("/x", "m"))
    assert result is not None
    assert marker.exists(), "embedded fallback should have run"


async def test_no_external_no_embedded_warns_no_crash(records_data_root, caplog):
    """Neither script_path (existing) nor script_filename → warn, no crash."""
    t = _make_trigger_with_data(records_data_root)
    handler = RunScriptActionHandler()
    action = TriggerAction(action_type=ActionType.RUN_SCRIPT)
    result = await handler.execute(t, action=action, changes=_changes("/x", "m"))
    assert result is None  # nothing to run


async def test_embedded_missing_file_no_crash(records_data_root, caplog):
    """script_filename references a file that doesn't exist in data_dir → warn, no crash."""
    t = _make_trigger_with_data(records_data_root)
    handler = RunScriptActionHandler()
    action = TriggerAction(action_type=ActionType.RUN_SCRIPT, script_filename="nonexistent.sh")
    result = await handler.execute(t, action=action, changes=_changes("/x", "m"))
    assert result is None
