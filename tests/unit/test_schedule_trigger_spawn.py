"""Unit tests for the schedule-trigger spawn helper.

Covers `flow_sdk/builtin/trigger.py:_fire_schedule_job` after the
`asset_ref` refactor. Confirms the spawned `AgenticProcess` carries:

- `target_typeid_str` set from the trigger's TypeId
- `instruction_content` set from the trigger's instruction
- no `source_vfs_path` (deleted field) and `asset_ref` is None
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin import trigger as trigger_module
from flow_sdk.builtin.trigger import Trigger, _fire_schedule_job


def test_agentic_process_no_source_vfs_path_field():
    """`source_vfs_path` was removed in the asset_ref refactor."""
    fields = AgenticProcess.model_fields
    assert "source_vfs_path" not in fields, (
        "AgenticProcess.source_vfs_path should have been removed by the asset_ref refactor"
    )
    assert "target_typeid_str" in fields
    assert "instruction_content" in fields
    assert "asset_ref" in fields


def test_schedule_trigger_constructor_compiles():
    """Schedule trigger entity construction with instruction must work."""
    t = Trigger(
        name="nightly_report",
        trigger_type="schedule",
        sched_trigger_type="cron",
        expr="0 9 * * *",
        instruction="Generate the nightly report",
        workdir="/tmp",
        enabled=True,
    )
    assert t.trigger_type == "schedule"
    assert t.instruction == "Generate the nightly report"
    assert t.expr == "0 9 * * *"
    assert t.counter == 0


def test_spawn_constructor_matches_trigger_py_line_90():
    """Reproduce the exact AgenticProcess(...) call from trigger.py:90 and
    verify every field referenced exists on the post-refactor entity.

    This catches regressions where `_fire_schedule_job` references a field
    deleted by the asset_ref refactor (e.g. `source_vfs_path`).
    """
    t = Trigger(
        name="t1",
        trigger_type="schedule",
        sched_trigger_type="cron",
        expr="* * * * *",
        instruction="do the thing",
        workdir="/tmp/work",
        project_id="proj-xyz",
        enabled=True,
    )

    # Mirror the constructor call at flow_sdk/builtin/trigger.py:90-96
    proc = AgenticProcess(
        instruction_content=t.instruction,
        workdir=t.workdir,
        target_typeid_str=str(t.typeid),
        project_id=t.project_id,
        visible=False,
    )

    assert proc.instruction_content == "do the thing"
    assert proc.workdir == "/tmp/work"
    assert proc.target_typeid_str == str(t.typeid)
    assert proc.project_id == "proj-xyz"
    assert proc.visible is False
    # Triggers don't have a backing file -> asset_ref absent / None
    assert proc.asset_ref is None


@pytest.mark.asyncio
async def test_fire_schedule_job_spawns_with_expected_fields(monkeypatch):
    """Drive `_fire_schedule_job` directly without DB or PTY, and assert the
    spawned AgenticProcess carries the trigger's instruction + target_typeid_str.
    """
    captured: dict = {}

    trig = Trigger(
        name="unit_sched_trigger",
        trigger_type="schedule",
        sched_trigger_type="cron",
        expr="* * * * *",
        instruction="please run the QA sweep",
        workdir="/tmp/qa",
        project_id="pid-1",
        enabled=True,
    )
    # Force a stable id (must be a valid TypeId identifier — uuid4 works).
    trig_id = str(uuid.uuid4())
    trig.id = trig_id

    async def fake_get_by_id(tid):
        assert tid == trig_id
        return trig

    async def fake_update(self):
        return None

    async def fake_save(self, *a, **kw):
        # Mirror real save() side-effect: assign an id if missing (must be uuid-shaped).
        if not getattr(self, "id", None):
            self.id = str(uuid.uuid4())
        captured["proc"] = self
        return self

    async def fake_start_pty(self, instruction=None, visible=None, **kwargs):
        captured["start_instruction"] = instruction
        captured["start_visible"] = visible
        return None

    def fake_append_entry(name, entry):
        captured["log_entry"] = (name, entry)

    monkeypatch.setattr(Trigger, "get_by_id", classmethod(lambda cls, tid: fake_get_by_id(tid)))
    monkeypatch.setattr(Trigger, "update", fake_update)
    monkeypatch.setattr(AgenticProcess, "save", fake_save)
    # Production calls ``proc.start_pty(...)`` (was ``proc.start`` pre-refactor).
    monkeypatch.setattr(AgenticProcess, "start_pty", fake_start_pty)

    from flow_sdk.fs_records import trigger_log as tl_mod
    monkeypatch.setattr(tl_mod.TriggerLogRecord, "append_entry", staticmethod(fake_append_entry))

    await _fire_schedule_job(trig_id)

    proc = captured.get("proc")
    assert proc is not None, "AgenticProcess was not constructed by _fire_schedule_job"
    assert proc.instruction_content == "please run the QA sweep"
    assert proc.target_typeid_str == str(trig.typeid)
    assert proc.workdir == "/tmp/qa"
    assert proc.project_id == "pid-1"
    assert proc.visible is False
    assert proc.asset_ref is None  # triggers don't have a backing file
    assert captured["start_instruction"] == "please run the QA sweep"
    assert captured["start_visible"] is False
    # Counter should have been bumped before spawn
    assert trig.counter == 1
    assert trig.last_run is not None
    # Log entry must reference the spawned process id
    name, entry = captured["log_entry"]
    assert name == "unit_sched_trigger"
    assert entry["agentic_process_id"] == proc.id
    assert entry["hook_event"] == "schedule_fire"
