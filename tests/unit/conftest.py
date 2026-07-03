"""Shared fixtures for unit tests that resolve Claude session transcripts."""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest

from flow_sdk.builtin.shell import Shell
from flow_sdk.fs_store.indexer.functions import claude_sessions as _claude_sessions
from flow_sdk.fs_store.record_paths import (
    get_default_records_data_root,
    get_default_records_root,
    set_default_records_data_root,
    set_default_records_root,
)

CLAUDE_SID = "11111111-1111-4111-8111-111111111111"


# ---------------------------------------------------------------------------
# Shared Shell/PTY helpers (used by test_shell_proc_interface + test_shell_io_worker)
# ---------------------------------------------------------------------------


def make_shell(**kwargs) -> Shell:
    """A Shell with random id + compute_node_id (no DB, no server)."""
    return Shell(id=str(uuid.uuid4()), compute_node_id=str(uuid.uuid4()), **kwargs)


async def poll_read(shell: Shell, keyword: bytes, timeout: float = 10.0) -> bytes:
    """Poll ``shell.read()`` until *keyword* appears, or raise on timeout."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        out = await shell.read()
        if keyword in out:
            return out
        await asyncio.sleep(0.1)
    out = await shell.read()
    raise TimeoutError(f"{keyword!r} not found within {timeout}s. last output: {out[-200:]!r}")


async def kill_pty(shell: Shell) -> None:
    """Tear down a shell's live PTY, if any."""
    pty = shell.compute_node.get_pty(shell.id) if shell.compute_node_id else None
    if pty:
        await pty.kill()


@pytest.fixture
def tmp_records_root(tmp_path, monkeypatch):
    """Redirect the records root at every binding site. NON-autouse: files that
    want it opt in with a module-level ``autouse`` wrapper (so it does not apply
    to unrelated unit tests).

    ``set_default_records_data_root`` rebinds only the lambda inside
    ``flow_sdk.fs_store.record``; modules that did ``from … import
    get_default_records_data_root`` keep their own binding, so patch those too.
    """
    orig_root = get_default_records_root()
    orig_data_root = get_default_records_data_root()
    set_default_records_root(tmp_path)
    set_default_records_data_root(tmp_path)
    import flow_sdk.builtin.shell as _shell_mod
    monkeypatch.setattr(
        _shell_mod, "get_default_records_data_root", lambda: tmp_path,
        raising=False,
    )
    yield tmp_path
    set_default_records_root(orig_root)
    set_default_records_data_root(orig_data_root)


def write_claude_transcript(proj: Path, sid: str = CLAUDE_SID, *, n_lines: int = 1) -> Path:
    """Write a Claude JSONL transcript of ``n_lines`` user messages under ``proj``.

    ``n_lines=1`` is the cheap resolvable-session case; a large count produces a
    realistically-heavy transcript for parse-cost tests.
    """
    lines = [
        json.dumps({
            "parentUuid": None, "isSidechain": False, "type": "user",
            "message": {"role": "user", "content": "hello world " * 40 + f" line {i}"},
            "uuid": f"00000000-0000-4000-8000-{i:012d}",
            "timestamp": "2026-04-26T13:12:32.389Z", "cwd": "/repo",
            "sessionId": sid, "version": "2.1.119", "gitBranch": "main",
        })
        for i in range(n_lines)
    ]
    p = proj / f"{sid}.jsonl"
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return p


@pytest.fixture
def claude_projects(tmp_path, monkeypatch) -> Path:
    """A tmp ``claude_projects_dir`` (get_instance_settings patched); returns the project dir.

    Pair with :func:`write_claude_transcript` to drop a resolvable session under it.
    """
    proj = tmp_path / "-repo"
    proj.mkdir()
    monkeypatch.setattr(
        _claude_sessions, "get_instance_settings",
        lambda: SimpleNamespace(claude_projects_dir=tmp_path),
    )
    return proj
