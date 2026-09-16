"""A retired ``agent.md`` becomes ``agent.json`` + ``system_prompt.md`` — same id, nothing lost, run once."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.assets.scanning import scan_repo_tree
from flow_sdk.fs_store.record_paths import get_default_records_root, set_default_records_root
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.migrations.migration_2026_09_entity_json_mains import migrate
from flow_sdk.schema.type_info import register_all

pytestmark = pytest.mark.timeout(10)  # do not increase without approval

AGENT_ID = "3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b"


@pytest.fixture
def repo(tmp_path: Path):
    register_all()
    previous = get_default_records_root()
    set_default_records_root(tmp_path / "records")
    try:
        yield tmp_path / "repo"
    finally:
        set_default_records_root(previous)


def _retired(repo: Path, name: str = "caller", *, agent_id: str = AGENT_ID, extra: str = "") -> Path:
    folder = repo / "agentic-assets" / "agent" / name
    folder.mkdir(parents=True)
    (folder / "agent.md").write_text(
        f"---\nid: {agent_id}\nversion: 3\nmodel: haiku\nenabled: true\n{extra}---\nYou answer calls.\n"
    )
    return folder


def test_the_scan_reports_a_retired_agent_and_names_the_migration(repo):
    _retired(repo)
    issues = [i for i in scan_repo_tree(repo, SchemaRegistry.repo_family_to_info()).issues if i.retired]
    assert [i.retired for i in issues] == ["agent.md"]
    assert "migration_2026_09_entity_json_mains" in issues[0].message


def test_dry_run_reports_and_writes_nothing(repo):
    folder = _retired(repo)
    report = migrate(dry_run=True, roots=[repo])
    assert dict(report.pending) == {"agent": 1} and not report.changed
    assert sorted(p.name for p in folder.iterdir()) == ["agent.md"]


def test_apply_keeps_the_id_version_and_prompt_then_a_second_run_is_a_no_op(repo):
    folder = _retired(repo, extra="not_a_field: x\n")
    report = migrate(dry_run=False, roots=[repo])
    assert dict(report.converted) == {"agent": 1} and dict(report.dropped_keys) == {"not_a_field": 1}
    assert sorted(p.name for p in folder.iterdir()) == ["agent.json", "system_prompt.md"]
    doc = json.loads((folder / "agent.json").read_text())
    assert list(doc)[:4] == ["type", "id", "name", "version"]
    assert (doc["id"], doc["version"], doc["model"], doc["enabled"]) == (AGENT_ID, 3, "haiku", True)
    assert (folder / "system_prompt.md").read_text() == "You answer calls.\n"
    assert migrate(dry_run=False, roots=[repo]).scanned == 0


def test_a_folder_holding_both_files_is_a_conflict_left_untouched(repo):
    folder = _retired(repo)
    (folder / "agent.json").write_text(json.dumps({"type": "agent", "id": AGENT_ID, "name": "caller"}))
    before = {p.name: p.read_bytes() for p in folder.iterdir()}
    report = migrate(dry_run=False, roots=[repo])
    assert len(report.conflicts) == 1 and not report.changed
    assert {p.name: p.read_bytes() for p in folder.iterdir()} == before


def test_a_foreign_id_is_not_adopted(repo):
    folder = _retired(repo, agent_id="0190f5d2-7c1e-7a3b-9c4d-5e6f7a8b9c0d")  # v7
    report = migrate(dry_run=False, roots=[repo])
    assert dict(report.unconverted) == {"agent:no-valid-id": 1}
    assert sorted(p.name for p in folder.iterdir()) == ["agent.md"]
