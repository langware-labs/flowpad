"""Startup catch-up parses in a child process.

``catch_up_via_child`` hands the pending files to
``flow_sdk.transcript_streamer.catch_up_child``, which parses them one at a
time and streams back one small record per file. The parent writes a cursor
row for every file nobody owns and takes the live path only for a file a
process owns or could adopt. A child that cannot finish hands the rest back
to the in-process loop.

Real child process (one spawn per test), real registry, real tmp JSONL files,
real process rows. The only substitution is the subscriber, as in
``test_catch_up.py``.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

import pytest

from flow_sdk.transcript_streamer import catch_up as catch_up_mod
from flow_sdk.transcript_streamer.catch_up import catch_up_via_child, child_env
from tests.unit.test_transcript_streamer.test_catch_up import _write_session, walk_registry  # noqa: F401

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)

CHILD = "flow_sdk.transcript_streamer.catch_up_child"
TRUNCATING_CHILD = "tests.unit.test_transcript_streamer._truncating_catch_up_child"


def _write_codex_session(path: Path, session_id: str) -> None:
    """A codex rollout: the ``session_meta`` header, then one user turn."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(line) + "\n" for line in [
        {"timestamp": "2026-03-11T15:02:01.000Z", "type": "session_meta",
         "payload": {"id": session_id, "cwd": "/repo"}},
        {"timestamp": "2026-03-11T15:02:02.000Z", "type": "response_item",
         "payload": {"type": "message", "role": "user",
                     "content": [{"type": "input_text", "text": "hello"}]}},
    ]), encoding="utf-8")


def test_child_streams_one_record_per_file_then_a_result_line(tmp_path: Path) -> None:
    """The child module on a Claude session, a codex rollout with its
    ``session_meta`` header, a file of malformed lines and a missing file:
    one record each, the terminal result line last, and nothing opened or
    created under the instance home."""
    claude_home = tmp_path / ".claude"
    codex_home = tmp_path / ".codex"
    claude_sid = "46111111-1111-4111-8111-111111111111"
    codex_sid = "019dddd0-1234-7000-9000-000000000002"
    claude = claude_home / "projects" / "encoded-cwd" / f"{claude_sid}.jsonl"
    codex = codex_home / "sessions" / "2026" / "03" / "11" / "rollout-2026-03-11T15-02-01-x.jsonl"
    garbage = claude_home / "projects" / "encoded-cwd" / "47111111-1111-4111-8111-111111111111.jsonl"
    missing = claude_home / "projects" / "encoded-cwd" / "48111111-1111-4111-8111-111111111111.jsonl"
    _write_session(claude, claude_sid, turns=3)
    _write_codex_session(codex, codex_sid)
    garbage.write_text("{not json\n{still not\n", encoding="utf-8")
    flow_home = tmp_path / "flow-home"

    env = {**os.environ, "FLOW_HOME": str(flow_home), "FLOW_INSTANCE": "catch-up-child-test"}
    request = {
        "files": [str(claude), str(codex), str(garbage), str(missing)],
        "vendor_homes": {"claude": str(claude_home), "codex": str(codex_home)},
    }
    proc = subprocess.run(
        [sys.executable, "-m", CHILD], input=json.dumps(request).encode(),
        capture_output=True, env=env, check=False,
    )
    assert proc.returncode == 0, proc.stderr.decode()
    lines = [json.loads(line) for line in proc.stdout.decode().splitlines() if line.strip()]

    assert lines[-1] == {"result": {"files": 4}}
    by_path = {rec["path"]: rec for rec in lines[:-1]}
    assert list(by_path) == request["files"]  # discovery order, one record each

    rec = by_path[str(claude)]
    st = claude.stat()
    assert rec["worker_type"] == "claude" and rec["session_id"] == claude_sid
    assert rec["has_session_meta"] is False and rec["entries"] > 0
    assert (rec["size"], rec["mtime_ns"]) == (st.st_size, st.st_mtime_ns)

    rec = by_path[str(codex)]
    assert rec["worker_type"] == "codex" and rec["session_id"] == codex_sid
    assert rec["has_session_meta"] is True and rec["entries"] > 0

    assert by_path[str(garbage)]["entries"] == 0  # malformed lines are skipped, not an error
    assert "FileNotFoundError" in by_path[str(missing)]["error"]
    # Never the instance DB — the child did not even materialize the home.
    assert not flow_home.exists()


def test_child_env_restamps_flow_instance(monkeypatch: pytest.MonkeyPatch) -> None:
    """An empty ``FLOW_INSTANCE`` in the parent's environment would resolve the
    child to prod; the env the parent builds carries the instance name."""
    from flow_sdk.instance_settings import get_instance_settings

    monkeypatch.setenv("FLOW_INSTANCE", "")
    assert child_env()["FLOW_INSTANCE"] == get_instance_settings().instance_name
    assert child_env()["FLOW_INSTANCE"] != ""


async def test_walk_falls_back_when_the_child_stream_is_truncated(
    walk_registry, monkeypatch: pytest.MonkeyPatch,  # noqa: F811
) -> None:
    """A child that emits one record and dies without the result line: the
    file it reported gets its cursor row from the record, and the files it
    never reached go through the in-process loop — every file ends up
    consumed, nothing is retained."""
    from flow_sdk.server import app as app_mod
    from flow_sdk.server.routes.bootstrap import first_bootstrap_served

    reg, settings = walk_registry
    dispatched: list[Path] = []

    async def probe(_sid: str, path: Path, _entries: list[Any]) -> None:
        dispatched.append(path)

    reg.subscribe("probe", probe)
    first_bootstrap_served.set()
    paths = []
    for i in range(3):
        sid = f"4911111{i}-1111-4111-8111-111111111111"
        jsonl = settings.claude_projects_dir / f"encoded-{i}" / f"{sid}.jsonl"
        _write_session(jsonl, sid, turns=2)
        paths.append(jsonl)
    before = len(reg)

    monkeypatch.setattr(catch_up_mod, "CHILD_MODULE", TRUNCATING_CHILD)
    catch_up_mod.reset_child_availability()
    await app_mod._transcript_catch_up_walk()

    assert all(not reg.needs_catch_up(p) for p in paths)
    # The child-handled file never dispatches (nobody owns it); the other two did.
    assert len(dispatched) == 2 and set(dispatched) < set(paths)
    assert len(reg) == before
    # The latch is for a child that cannot be spawned, not for a bad stream.
    assert catch_up_mod._CHILD_UNAVAILABLE is False


async def test_owned_and_adoptable_files_take_the_live_path(walk_registry) -> None:  # noqa: F811
    """Through the real child: a Claude session a process row owns and a codex
    rollout an id-less running codex process could adopt go through
    ``registry.catch_up`` (dispatched, the claimed one retained); a session
    nobody owns only gets its cursor row and is never dispatched."""
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.builtin.process_lifecycle import ProcessStatus
    from flow_sdk.flowpad_types.enums import WorkerType

    reg, settings = walk_registry
    owned_sid = str(uuid.uuid4())
    loose_sid = str(uuid.uuid4())
    codex_sid = "019dddd0-1234-7000-9000-000000000003"
    owned = settings.claude_projects_dir / "a" / f"{owned_sid}.jsonl"
    loose = settings.claude_projects_dir / "b" / f"{loose_sid}.jsonl"
    codex = settings.codex_sessions_dir / "2026" / "03" / "11" / "rollout-2026-03-11T15-02-01-y.jsonl"
    _write_session(owned, owned_sid, turns=2)
    _write_session(loose, loose_sid, turns=2)
    _write_codex_session(codex, codex_sid)

    dispatched: list[Path] = []

    async def probe(sid: str, path: Path, _entries: list[Any]) -> bool:
        dispatched.append(path)
        return sid == owned_sid

    reg.subscribe("probe", probe)
    owner = AgenticProcess(id=str(uuid.uuid4()), session_id=owned_sid, worker_type=WorkerType.CLAUDE_CODE)
    adopter = AgenticProcess(id=str(uuid.uuid4()), worker_type=WorkerType.CODEX)
    adopter.status = ProcessStatus.RUNNING.value
    await owner.save(notify=False)
    await adopter.save(notify=False)
    before = len(reg)
    try:
        catch_up_mod.reset_child_availability()
        remaining = await catch_up_via_child([owned, loose, codex])
        kept = reg.get_streamer_by_path(owned) is not None
        retained = len(reg) - before
    finally:
        await owner.delete()
        await adopter.delete()
        reg.remove_by_path(owned)

    assert remaining == []
    assert set(dispatched) == {owned, codex}
    assert all(not reg.needs_catch_up(p) for p in (owned, loose, codex))
    # Only the claimed session kept its streamer; the adoptable one was
    # dispatched but not claimed by the probe, the loose one never built one.
    assert kept and retained == 1
    assert reg.get_streamer_by_path(loose) is None
    assert reg.get_streamer_by_path(codex) is None
