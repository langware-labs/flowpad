"""A near-miss in a family mount is COLLECTED as a scan issue, never silently skipped."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.indexer.index_log import read_scan_issues
from flow_sdk.fs_store.indexer.walkers.generic import layout_walker
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.schema.type_info.skill_type_info import SKILL

pytestmark = pytest.mark.timeout(5)


def test_yaml_only_skill_folder_is_an_issue_not_a_ref(tmp_path: Path) -> None:
    home = tmp_path / "home"
    yaml_only = home / ".claude" / "skills" / "yaml-only"
    yaml_only.mkdir(parents=True)
    (yaml_only / "skill.yaml").write_text("name: y\n", encoding="utf-8")
    real = home / ".claude" / "skills" / "real"
    real.mkdir()
    (real / "SKILL.md").write_text("# real\n", encoding="utf-8")
    (home / ".claude" / "skills" / ".DS_Store").write_text("", encoding="utf-8")

    schema_dir = tmp_path / "schema"
    with patch("flow_sdk.fs_store.indexer.index_log._schema_dir", lambda: schema_dir):
        refs = layout_walker(SKILL)(
            [FSRef(home, record_type=RecordType.USER_HOME_FOLDER)], IndexerOptions(verbose=False)
        )
        issues = read_scan_issues("skill")

    assert [r._path.name for r in refs] == ["real"]
    assert len(issues) == 1
    issue = issues[0]
    assert issue.kind == "unclassified_in_family_dir"
    assert issue.type_name == "skill"
    assert Path(issue.path) == yaml_only
    assert "SKILL.md" in issue.detail


def test_folder_wide_walk_never_logs_ordinary_folders(tmp_path: Path) -> None:
    """The "skill anywhere" walk asks every project folder; a plain ``src/``
    is not a near-miss, so nothing is logged for it."""
    src = tmp_path / "src"
    src.mkdir()
    schema_dir = tmp_path / "schema"
    with patch("flow_sdk.fs_store.indexer.index_log._schema_dir", lambda: schema_dir):
        refs = layout_walker(SKILL)([FSRef(src, record_type=RecordType.FOLDER)], IndexerOptions(verbose=False))
        issues = read_scan_issues("skill")
    assert refs == [] and issues == []
