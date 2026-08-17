from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef


def test_skill_record_main_ref_points_to_inner_skill_file(tmp_path: Path):
    folder = tmp_path / "demo-skill"
    folder.mkdir()
    (folder / "SKILL.md").write_text("# Demo", encoding="utf-8")
    record = FSRecord(type="skill", id="record-main-ref-test")
    record.asset_ref = FSRef(folder)

    assert record.main_ref is not None
    assert record.main_ref.path == str(folder / "SKILL.md")
    assert record.main_ref.to_dict()["type_id"] == "compute_node-@local"
