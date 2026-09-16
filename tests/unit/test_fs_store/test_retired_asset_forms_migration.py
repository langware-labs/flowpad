"""An asset in a retired form (the data driver rename: data_source/ + data_source.json) converts — once."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.assets.scanning import scan_repo_tree
from flow_sdk.fs_store.record_paths import get_default_records_root, set_default_records_root
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.migrations.migration_2026_09_retired_asset_forms import migrate
from flow_sdk.schema.type_info import register_all

pytestmark = pytest.mark.timeout(10)  # do not increase without approval

MANIFEST = {"schema": 1, "name": "rss", "title": "RSS / Atom"}


@pytest.fixture
def repo(tmp_path: Path):
    register_all()
    previous = get_default_records_root()
    set_default_records_root(tmp_path / "records")
    try:
        yield tmp_path / "repo"
    finally:
        set_default_records_root(previous)


def _written(repo: Path, family: str, main: str, name: str = "rss") -> Path:
    folder = repo / "agentic-assets" / family / name
    folder.mkdir(parents=True)
    (folder / main).write_text(json.dumps({**MANIFEST, "name": name}))
    (folder / "source.py").write_text("# the driver\n")
    return folder


def _issues(repo: Path) -> list:
    return [i for i in scan_repo_tree(repo, SchemaRegistry.repo_family_to_info()).issues if i.type_name == "data_source_spec"]


def test_the_scan_reports_a_retired_family_instead_of_skipping_it(repo):
    _written(repo, "data_source", "data_source.json")
    [issue] = _issues(repo)
    assert issue.path.name == "rss" and "data_source/ is a retired" in issue.message
    assert "migration_2026_09_retired_asset_forms" in issue.message


def test_the_scan_reports_a_retired_main_in_the_current_family(repo):
    _written(repo, "data_driver", "data_source.json")
    [issue] = _issues(repo)
    assert issue.retired == "data_source.json" and "migration_2026_09_retired_asset_forms" in issue.message


def test_dry_run_counts_and_writes_nothing(repo):
    folder = _written(repo, "data_source", "data_source.json")
    report = migrate(dry_run=True, roots=[repo])
    assert (report.moved, report.renamed, report.changed) == (1, 1, False)
    assert sorted(p.name for p in folder.iterdir()) == ["data_source.json", "source.py"]


def test_apply_moves_the_folder_renames_the_main_and_a_second_run_is_a_no_op(repo):
    _written(repo, "data_source", "data_source.json")
    report = migrate(dry_run=False, roots=[repo])
    assert (report.moved, report.renamed, report.changed) == (1, 1, True)

    moved = repo / "agentic-assets" / "data_driver" / "rss"
    assert sorted(p.name for p in moved.iterdir()) == ["data_driver.json", "source.py"]
    assert json.loads((moved / "data_driver.json").read_text())["name"] == "rss"
    assert not (repo / "agentic-assets" / "data_source").exists(), "an emptied old family is removed"
    assert _issues(repo) == []

    again = migrate(dry_run=False, roots=[repo])
    assert (again.moved, again.renamed, again.changed) == (0, 0, False)


def test_an_existing_destination_is_a_conflict_and_nothing_moves(repo):
    old = _written(repo, "data_source", "data_source.json")
    kept = _written(repo, "data_driver", "data_driver.json")
    report = migrate(dry_run=False, roots=[repo])
    assert report.conflicts == [str(old)] and report.moved == 0
    assert (old / "data_source.json").is_file() and (kept / "data_driver.json").is_file()


def test_a_folder_holding_both_mains_is_found_and_reported_as_a_conflict(repo):
    folder = _written(repo, "data_driver", "data_source.json")
    (folder / "data_driver.json").write_text(json.dumps(MANIFEST))
    report = migrate(dry_run=False, roots=[repo])
    assert (report.renamed, report.conflicts) == (0, [str(folder)])
    assert (folder / "data_source.json").is_file() and (folder / "data_driver.json").is_file()


def test_the_entity_document_migration_leaves_a_driver_manifest_alone(repo):
    from flow_sdk.migrations.migration_2026_09_entity_json_mains import migrate as migrate_entity_documents

    _written(repo, "data_driver", "data_source.json")
    report = migrate_entity_documents(dry_run=False, roots=[repo])
    assert (report.scanned, dict(report.unconverted)) == (0, {})


def test_a_retired_runtime_is_reported_by_the_scan_with_its_port(repo):
    folder = _written(repo, "data_driver", "data_driver.json")
    (folder / "fetch.py").write_text("print('{}')\n")
    [issue] = _issues(repo)
    assert issue.retired == "fetch.py" and "write source.py" in issue.message
    assert not [c for c in scan_repo_tree(repo, SchemaRegistry.repo_family_to_info()).candidates
                if c.type_name == "data_source_spec"], "a folder the indexer would refuse is never handed to it"


def test_moving_a_retired_runtime_still_says_it_needs_a_port(repo):
    folder = _written(repo, "data_source", "data_source.json")
    (folder / "fetch.py").write_text("print('{}')\n")
    report = migrate(dry_run=False, roots=[repo])
    moved = repo / "agentic-assets" / "data_driver" / "rss"
    assert (report.moved, report.renamed, report.needs_port) == (1, 1, [str(moved)])
    assert "need a manual port" in report.summary()
