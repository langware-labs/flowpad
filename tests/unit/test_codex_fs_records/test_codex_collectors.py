"""Codex indexer-function tests — codex_projects_fn + codex session extraction.

Repointed from the deleted ``system_profile`` codex collectors to the canonical
indexer functions (``indexer/functions/codex_projects.py`` + ``codex_sessions.py``).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.functions.codex_projects import (
    _read_codex_projects_from_config,
    _scan_cwd,
    codex_projects_fn,
)
from flow_sdk.fs_store.indexer.functions.codex_sessions import (
    discover_codex_session_paths_iter,
    ensure_codex_session_stats,
    extract_codex_session_from_path,
    get_codex_session,
)
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


def test_codex_projects_discovery(codex_sandbox: Path):
    """codex_projects_fn discovers cwds from config.toml + rollout session_meta."""
    home = codex_sandbox.parent  # the dir containing .codex
    root = FSRef(home, record_type=RecordType.USER_HOME_FOLDER)
    refs = codex_projects_fn([root], IndexerOptions())
    cwds = {str(r.path) for r in refs}
    assert "/repo" in cwds
    assert "/Users/test/never_used" in cwds  # config-only project still discovered
    assert "/Users/test/proj_b" in cwds


def test_codex_config_and_rollout_reject_home_but_keep_subdir_and_windows(
    tmp_path,
    monkeypatch,
):
    import dataclasses
    import json

    import flow_sdk.instance_settings as instance_settings

    home = tmp_path / "home"
    project = home / "dev" / "repo"
    project.mkdir(parents=True)
    patched = dataclasses.replace(
        instance_settings.get_instance_settings(),
        user_home=home,
    )
    monkeypatch.setattr(instance_settings, "get_instance_settings", lambda: patched)

    config = tmp_path / "config.toml"
    config.write_text(
        f'[projects."{home}"]\ntrust_level = "trusted"\n'
        f'[projects."{project}"]\ntrust_level = "trusted"\n'
        r"[projects.'C:\work\repo']" + "\ntrust_level = \"trusted\"\n"
    )
    projects = _read_codex_projects_from_config(config, include_temp=True)
    assert str(home) not in projects
    assert str(project) in projects
    assert r"C:\work\repo" in projects

    home_rollout = tmp_path / "rollout-home.jsonl"
    home_rollout.write_text(json.dumps(
        {"type": "session_meta", "payload": {"cwd": str(home)}}
    ))
    project_rollout = tmp_path / "rollout-project.jsonl"
    project_rollout.write_text(json.dumps(
        {"type": "session_meta", "payload": {"cwd": str(project)}}
    ))
    assert _scan_cwd(home_rollout, include_temp=True) is None
    assert _scan_cwd(project_rollout, include_temp=True) == str(project)


def _sessions_with_stats() -> list:
    recs = []
    for path in discover_codex_session_paths_iter():
        rec = extract_codex_session_from_path(path)
        ensure_codex_session_stats(rec)
        recs.append(rec)
    return recs


def test_codex_session_head_fields(codex_sandbox: Path):
    recs = [extract_codex_session_from_path(p) for p in discover_codex_session_paths_iter()]
    assert len(recs) == 2
    for r in recs:
        assert r.worker_type == "codex"
        assert str(r.type) == str(RecordType.CODEX_SESSION)
        assert r.cwd in {"/repo", "/Users/test/proj_b"}


def test_codex_session_full_stats(codex_sandbox: Path):
    recs = _sessions_with_stats()
    s = next(x for x in recs if x.cwd == "/repo")
    assert s.message_count == 2
    assert s.user_message_count == 1
    assert s.assistant_message_count == 1
    assert s.model == "gpt-5.3-codex"
    assert s.primary_model == "gpt-5.3-codex"
    assert s.last_user_message == "Add a small helper function that prints hello."
    assert s.effort == "xhigh"
    assert s.estimated_cost_usd == 0.0


def test_codex_global_limit(codex_sandbox: Path):
    paths = list(discover_codex_session_paths_iter(limit=1))
    assert len(paths) == 1


def test_unknown_codex_session_returns_none(codex_sandbox: Path):
    assert get_codex_session("00000000-0000-0000-0000-000000000000") is None
