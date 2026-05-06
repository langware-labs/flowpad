"""Collector tests — get_codex_projects, get_recent_codex_sessions."""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from flow_sdk.core.resource_management.scan.system_profile._collectors.codex_project_collector import (
    get_codex_projects,
)
from flow_sdk.core.resource_management.scan.system_profile._collectors.codex_session_collector import (
    get_codex_session_info,
    get_codex_session_info_quick,
    get_recent_codex_sessions,
)


# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


def test_get_codex_projects_shape(codex_sandbox: Path):
    projects = get_codex_projects()
    assert projects, "expected at least one Codex project"
    by_cwd = {p["cwd"]: p for p in projects}

    assert by_cwd["/repo"]["worker_type"] == "codex"
    assert by_cwd["/repo"]["type"] == "codex_project"
    assert by_cwd["/repo"]["trust_level"] == "trusted"
    assert by_cwd["/repo"]["session_count"] == 1
    assert by_cwd["/repo"]["originators"] == ["codex_cli_rs"]
    assert by_cwd["/Users/test/never_used"]["session_count"] == 0


def test_quick_session_info(codex_sandbox: Path):
    sessions = get_recent_codex_sessions(quick=True)
    assert len(sessions) == 2
    s = sessions[0]
    assert s["worker_type"] == "codex"
    assert s["type"] == "codex_session"
    assert s["message_count"] == 2
    assert s["user_messages"] == 1
    assert s["assistant_messages"] == 1
    assert s["cwd"] in {"/repo", "/Users/test/proj_b"}


def test_slow_session_info_full_stats(codex_sandbox: Path):
    sessions = get_recent_codex_sessions(quick=False)
    assert len(sessions) == 2
    s = next(x for x in sessions if x["cwd"] == "/repo")
    assert s["model"] == "gpt-5.3-codex"
    assert s["primary_model"] == "gpt-5.3-codex"
    assert s["last_user_message"] == "Add a small helper function that prints hello."
    assert s["effort"] == "xhigh"
    assert s["estimated_cost_usd"] == 0.0


def test_global_limit(codex_sandbox: Path):
    sessions = get_recent_codex_sessions(limit=1, quick=True)
    assert len(sessions) == 1


def test_per_project_limit(codex_sandbox: Path):
    sessions = get_recent_codex_sessions(limit=10, per_project_limit=1, quick=True)
    cwds = [s["cwd"] for s in sessions]
    # Both projects represented, but ≤1 each.
    assert sorted(cwds) == ["/Users/test/proj_b", "/repo"]


def test_mtime_ordering_newest_first(
    codex_sandbox: Path,
):
    """Modify rollout 2's mtime to be newer than rollout 1, expect it first."""
    rollouts = sorted((codex_sandbox / "sessions").rglob("rollout-*.jsonl"))
    older, newer = rollouts[0], rollouts[1]
    # Force older to be older.
    past = time.time() - 60
    import os
    os.utime(older, (past, past))

    sessions = get_recent_codex_sessions(quick=True)
    # Newer-mtime path must come first in result list.
    assert sessions[0]["path"] == str(newer)


def test_session_info_returns_none_for_nonexistent(tmp_path: Path):
    assert get_codex_session_info_quick(tmp_path / "missing.jsonl") is None
    assert get_codex_session_info(tmp_path / "missing.jsonl") is None
