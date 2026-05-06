"""Shared fixtures for Codex fs_record / collector tests.

Builds a sandboxed ``$CODEX_HOME`` with real fixture rollouts so tests drive
the actual filesystem path (no mocks — matches the project's standing rule).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

_FIXTURES = (
    Path(__file__).resolve().parent.parent / "resources" / "transcripts"
)


@pytest.fixture()
def codex_rollout_src() -> str:
    return (_FIXTURES / "codex_rollout.jsonl").read_text()


@pytest.fixture()
def codex_stream_src() -> str:
    return (_FIXTURES / "codex_stream_events.jsonl").read_text()


@pytest.fixture()
def codex_sandbox(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    codex_rollout_src: str,
) -> Path:
    """Set up a fresh ``$CODEX_HOME`` with two rollouts and a config.toml.

    Yields the sandbox root. Sessions live under ``YYYY/MM/DD`` to mirror
    real Codex layout. The fixture clears the cached InstanceSettings so the
    new env var is picked up.
    """
    codex_home = tmp_path / ".codex"
    sessions = codex_home / "sessions" / "2026" / "03" / "11"
    sessions.mkdir(parents=True)

    # Rollout 1 — /repo (referenced in fixture)
    (sessions / "rollout-2026-03-11T17-02-01-019cdd6b-49a7-7480-9da1-aaaaaaaaaaaa.jsonl").write_text(
        codex_rollout_src
    )
    # Rollout 2 — different cwd, different thread_id
    src2 = codex_rollout_src.replace('"cwd": "/repo"', '"cwd": "/Users/test/proj_b"', 1)
    (sessions / "rollout-2026-03-11T17-30-00-019cdd99-49a7-7480-9da1-bbbbbbbbbbbb.jsonl").write_text(
        src2
    )

    # config.toml: /repo trusted, never_used untrusted (no rollout)
    (codex_home / "config.toml").write_text(
        '[projects."/repo"]\ntrust_level = "trusted"\n'
        '\n[projects."/Users/test/never_used"]\ntrust_level = "untrusted"\n'
    )

    monkeypatch.setenv("CODEX_HOME", str(codex_home))
    # Force settings re-resolution.
    from flow_sdk import instance_settings as ist
    monkeypatch.setattr(ist, "_SETTINGS", None, raising=False)
    yield codex_home
