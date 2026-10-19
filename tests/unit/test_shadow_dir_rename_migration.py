"""Legacy ``<type>-@<id>`` record folders are renamed to ``<id>``, and nothing is ever lost."""

from __future__ import annotations

import json
from pathlib import Path

from flow_sdk.migrations.migration_2026_10_shadow_dir_rename import run

A = "11111111-1111-4111-8111-111111111111"
B = "22222222-2222-4222-8222-222222222222"
C = "33333333-3333-4333-8333-333333333333"


def _record(folder: Path, rid: str, **extra) -> Path:
    folder.mkdir(parents=True)
    (folder / "metadata.json").write_text(json.dumps({"type": folder.parent.name, "id": rid, **extra}))
    return folder


def _store(tmp_path: Path) -> Path:
    root = tmp_path / "records"
    _record(root / "markdown" / f"markdown-@{A}", A, name="legacy")
    (root / "markdown" / f"markdown-@{A}" / "1_abc_def.hash").write_text("")
    _record(root / "markdown" / B, B, name="already bare")
    _record(root / "markdown" / f"markdown-@{C}", C, name="stale twin")
    _record(root / "markdown" / C, C, name="live twin")
    (root / "markdown" / f"markdown-@{B}").mkdir()          # no metadata.json: not a record
    _record(root / "skill" / f"markdown-@{A}", A)            # another type's prefix: not legacy here
    return root


def test_dry_run_reports_and_touches_nothing(tmp_path: Path) -> None:
    root = _store(tmp_path)
    before = sorted(str(p.relative_to(root)) for p in root.rglob("*"))
    report = run(root)
    assert (report.renamed, len(report.collisions), report.not_records, report.errors) == (1, 1, 1, [])
    assert sorted(str(p.relative_to(root)) for p in root.rglob("*")) == before


def test_apply_renames_keeps_sentinel_and_never_overwrites(tmp_path: Path) -> None:
    root = _store(tmp_path)
    report = run(root, apply=True)
    assert report.renamed == 1 and not report.errors
    moved = root / "markdown" / A
    assert json.loads((moved / "metadata.json").read_text())["name"] == "legacy"
    assert (moved / "1_abc_def.hash").exists()                      # the sentinel travels with it
    assert not (root / "markdown" / f"markdown-@{A}").exists()
    assert json.loads((root / "markdown" / C / "metadata.json").read_text())["name"] == "live twin"
    assert (root / "markdown" / f"markdown-@{C}").is_dir()           # the collision is left in place
    assert (root / "skill" / f"markdown-@{A}").is_dir()


def test_second_run_is_a_no_op(tmp_path: Path) -> None:
    root = _store(tmp_path)
    run(root, apply=True)
    again = run(root, apply=True)
    assert again.renamed == 0 and len(again.collisions) == 1


def test_renamed_record_is_found_by_id(tmp_path: Path) -> None:
    from flow_sdk.fs_store.fs_record import FSRecord
    from flow_sdk.fs_store.record_paths import get_default_records_root, set_default_records_root

    root = _store(tmp_path)
    previous = get_default_records_root()
    set_default_records_root(root)
    try:
        assert FSRecord.load_or_none("markdown", A) is None
        run(root, apply=True)
        assert FSRecord.load_or_none("markdown", A).name == "legacy"
    finally:
        set_default_records_root(previous)
