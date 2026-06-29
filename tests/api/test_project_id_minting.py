"""Tests for the unified cwd→project_id minting primitive.

``resolve_project_id_for_cwd`` is the single sync resolver the indexer uses to
stamp ``project_id`` on cwd-bearing records whose FSRef parent chain has no
project-scoped ancestor (codex/copilot sessions, received transcripts). It
returns the real Project entity id when one owns the path, else the
path-derived uuid5 alias that ``resolve_project_scope`` normalizes at query
time.

The DB-backed cases populate a sqlite file *synchronously* and point
``db_path`` at it: the resolver reads the sqlite file directly (the same
pattern as ``lookup_project_id_by_uname``), so this exercises the real SQL
without the async-fixture / TestClient DB split-brain.
"""

from __future__ import annotations

import json
import uuid

import pytest

from flow_sdk.builtin.project import Project
from flow_sdk.db.drivers.sqlite.connection import open_sqlite
from flow_sdk.fs_store.indexer import roots as roots_mod
from flow_sdk.fs_store.indexer.roots import resolve_project_id_for_cwd
from flow_sdk.fs_store.path_utils import canonical_posix_path


@pytest.fixture(autouse=True)
def _clear_cwd_cache():
    """The resolver memoizes by canonical cwd; isolate each test."""
    roots_mod._CWD_PID_CACHE.clear()
    yield
    roots_mod._CWD_PID_CACHE.clear()


def _make_db_with_project(db_path, *, project_id: str, mount_path: str) -> None:
    """Create a minimal entities table with one project row (sync)."""
    conn = open_sqlite(str(db_path))
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS entities "
            "(id TEXT PRIMARY KEY, type TEXT, uname TEXT, data TEXT)"
        )
        conn.execute(
            "INSERT INTO entities (id, type, data) VALUES (?, 'project', ?)",
            (project_id, json.dumps({"fs_storage_mount_path": mount_path})),
        )
        conn.commit()
    finally:
        conn.close()


def _point_db_path(monkeypatch, db_path) -> None:
    """Make ``get_instance_settings().db_path`` return ``db_path``."""
    import flow_sdk.instance_settings as instance_settings
    from types import SimpleNamespace

    settings = SimpleNamespace(db_path=str(db_path))
    monkeypatch.setattr(instance_settings, "get_instance_settings", lambda: settings)


def test_empty_cwd_returns_none():
    assert resolve_project_id_for_cwd("") is None
    assert resolve_project_id_for_cwd(None) is None


def test_unknown_cwd_falls_back_to_derived_alias(tmp_path, monkeypatch):
    """No Project at the path → the deterministic uuid5 alias (not None)."""
    db_path = tmp_path / "empty.db"
    _make_db_with_project(db_path, project_id=str(uuid.uuid4()), mount_path=str(tmp_path / "other"))
    _point_db_path(monkeypatch, db_path)

    target = tmp_path / "no-project-here"
    target.mkdir()
    pid = resolve_project_id_for_cwd(str(target))
    assert pid == Project.derive_id_for_path(str(target))
    assert pid == str(uuid.uuid5(uuid.NAMESPACE_DNS, f"project:{canonical_posix_path(target)}"))


def test_existing_uuid4_project_resolves_to_real_entity_id(tmp_path, monkeypatch):
    """A Project with a non-derived (uuid4) id is found by canonical-path scan,
    so the resolver returns the REAL entity id — not the derived alias."""
    target = tmp_path / "uuid4-project"
    target.mkdir()
    real_id = str(uuid.uuid4())
    db_path = tmp_path / "db.db"
    _make_db_with_project(db_path, project_id=real_id, mount_path=canonical_posix_path(target))
    _point_db_path(monkeypatch, db_path)

    pid = resolve_project_id_for_cwd(str(target))
    assert pid == real_id
    assert pid != Project.derive_id_for_path(str(target))


def test_codex_session_record_carries_cwd_for_stamping(tmp_path, monkeypatch):
    """End-to-end seam: a codex rollout's extracted record carries the `cwd`
    the indexer's generic stamp feeds to `resolve_project_id_for_cwd`. Codex
    sessions expand under USER_HOME_FOLDER (no project-scoped FSRef ancestor),
    so without this the record's project_id stays null and the transcript
    yields no project tab."""
    import json as _json

    from flow_sdk.fs_store.indexer.functions.codex_sessions import (
        extract_codex_session_from_path,
    )

    proj_dir = tmp_path / "work" / "repo"
    proj_dir.mkdir(parents=True)
    rollout = tmp_path / f"rollout-2026-01-01T00-00-00-{'1' * 8}-1111-4111-8111-111111111111.jsonl"
    rollout.write_text(
        _json.dumps(
            {"type": "session_meta", "payload": {"id": str(uuid.uuid4()), "cwd": str(proj_dir)}}
        )
        + "\n"
    )

    rec = extract_codex_session_from_path(rollout, include_content=False)
    assert rec.cwd == str(proj_dir)

    # The generic stamp would resolve this cwd to a (non-null) project id.
    _make_db_with_project(tmp_path / "db.db", project_id=str(uuid.uuid4()), mount_path=str(proj_dir / "other"))
    _point_db_path(monkeypatch, tmp_path / "db.db")
    pid = resolve_project_id_for_cwd(rec.cwd)
    assert pid == Project.derive_id_for_path(str(proj_dir))


def test_resolution_is_canonical_path_insensitive(tmp_path, monkeypatch):
    """A trailing-slash / non-canonical cwd still resolves to the same project."""
    target = tmp_path / "canon-project"
    target.mkdir()
    real_id = str(uuid.uuid4())
    db_path = tmp_path / "db.db"
    _make_db_with_project(db_path, project_id=real_id, mount_path=canonical_posix_path(target))
    _point_db_path(monkeypatch, db_path)

    pid = resolve_project_id_for_cwd(str(target) + "/")
    assert pid == real_id
