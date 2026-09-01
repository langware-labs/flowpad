from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from flow_sdk.assets.entity_vfs import local_asset_vfs_binding
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


def test_file_valued_skill_ref_uses_owning_folder_without_double_append(tmp_path: Path):
    folder = tmp_path / "demo-skill"
    folder.mkdir()
    main = folder / "SKILL.md"
    main.write_text("# Demo", encoding="utf-8")
    record = FSRecord(type="skill", id="record-file-ref-test")
    record.asset_ref = FSRef(main)

    assert record.main_ref is not None
    assert record.main_ref.path == str(main)

    entity = SimpleNamespace(asset_ref=str(main), get_type=lambda: "skill")
    binding = local_asset_vfs_binding(entity)
    assert binding is not None
    assert binding.root == folder.resolve()
    assert binding.main_ref == "SKILL.md"
