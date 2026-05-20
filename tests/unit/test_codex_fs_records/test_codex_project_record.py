"""CodexProjectFsRecord tests — dual-source discovery, dedup, sessions filter.

DEFERRED 2026-05-09 (project consolidation phase 1):
``CodexProjectFsRecord`` is now an alias for the consolidated
``ProjectFsRecord``. The tests below assert the OLD per-class semantics
(``_record_type == CODEX_PROJECT``, deterministic ``uuid5(cwd)`` ids,
on-the-fly ``discover()`` scanning config.toml + rollouts, ``trust_level``
and ``sessions`` properties Codex-only). These semantics were intentionally
collapsed. New tests covering the consolidated behaviour live in (TODO)
``tests/unit/test_fs_records/test_project_record.py`` and will be written
in Phase 7 of the consolidation.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.fs_records.codex import CodexProjectFsRecord
from flow_sdk.fs_records.codex.codex_project import _codex_project_id
from flow_sdk.fs_store import RecordType


# do not increase timeout without approval
pytestmark = [
    pytest.mark.timeout(30),
    pytest.mark.skip(
        reason="Codex projects consolidated into ProjectFsRecord 2026-05-09; "
               "new tests pending in Phase 7 of the consolidation."
    ),
]


def test_record_type_and_indexing():
    assert CodexProjectFsRecord._record_type == RecordType.CODEX_PROJECT
    assert CodexProjectFsRecord._indexed_by_default is True


def test_discover_merges_config_and_rollouts(codex_sandbox: Path):
    projects = CodexProjectFsRecord.discover()
    cwd_to_rec = {p.cwd: p for p in projects}

    # /repo is in both config.toml and a rollout — merged.
    assert "/repo" in cwd_to_rec
    assert cwd_to_rec["/repo"].trust_level == "trusted"
    assert cwd_to_rec["/repo"].originators == ["codex_cli_rs"]

    # /Users/test/proj_b is rollout-only.
    assert "/Users/test/proj_b" in cwd_to_rec
    assert cwd_to_rec["/Users/test/proj_b"].trust_level is None

    # /Users/test/never_used is config-only (no rollout) — still present.
    assert "/Users/test/never_used" in cwd_to_rec
    assert cwd_to_rec["/Users/test/never_used"].trust_level == "untrusted"
    assert cwd_to_rec["/Users/test/never_used"].session_count == 0


def test_dedup_by_id(codex_sandbox: Path):
    projects = CodexProjectFsRecord.discover()
    ids = [p.id for p in projects]
    assert len(ids) == len(set(ids))


def test_id_is_uuid5_of_cwd():
    rec = CodexProjectFsRecord._from_cwd("/repo", trust_level="trusted")
    assert rec.id == _codex_project_id("/repo")


def test_get_by_id(codex_sandbox: Path):
    expected = _codex_project_id("/repo")
    found = CodexProjectFsRecord.get(expected)
    assert found is not None
    assert found.cwd == "/repo"


def test_sessions_property_filters_by_cwd(codex_sandbox: Path):
    projects = {p.cwd: p for p in CodexProjectFsRecord.discover()}
    repo = projects["/repo"]
    sess = repo.sessions
    assert len(sess) == 1
    assert all(s.cwd == "/repo" for s in sess)


def test_session_count(codex_sandbox: Path):
    projects = {p.cwd: p for p in CodexProjectFsRecord.discover()}
    assert projects["/repo"].session_count == 1
    assert projects["/Users/test/proj_b"].session_count == 1
    assert projects["/Users/test/never_used"].session_count == 0


def test_temp_paths_filtered_out(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    codex_rollout_src: str,
):
    """Rollouts whose cwd is /tmp/... or /var/folders/... must not surface as projects."""
    codex_home = tmp_path / ".codex"
    sessions = codex_home / "sessions" / "2026" / "03" / "11"
    sessions.mkdir(parents=True)
    bad = codex_rollout_src.replace('"cwd": "/repo"', '"cwd": "/tmp/throwaway"', 1)
    (sessions / "rollout-2026-03-11T17-02-01-019cdd6b-49a7-7480-9da1-cccccccccccc.jsonl").write_text(
        bad
    )
    (codex_home / "config.toml").write_text("")

    monkeypatch.setenv("CODEX_HOME", str(codex_home))
    from flow_sdk import instance_settings as ist
    monkeypatch.setattr(ist, "_SETTINGS", None, raising=False)

    projects = CodexProjectFsRecord.discover()
    assert all(not p.cwd.startswith("/tmp/") for p in projects)
