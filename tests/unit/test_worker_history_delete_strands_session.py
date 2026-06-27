"""Regression: deleting a chat in the Chats side-menu must actually remove it.

Bug (proven this session): the trash button issues
``DELETE /graph/agentic_process/<id>`` — which removes only the DB entity. The
session's on-disk Claude transcript is left untouched, and BOTH read paths
re-derive the session straight from that file:

* ``worker_history.get_worker_history`` — its Claude provider walks
  ``claude_projects_dir`` and re-emits the row (now ``agentic_process_id=None``).
* ``scan_actions._resolve_session_record`` — the on-disk resolver behind
  ``AgenticProcess.getByWorkerId`` (``terminals/get_by_worker_id``), which would
  re-upsert a brand-new process from the same file.

So a "deleted" chat both stays in the list and remains resolvable by its worker
session id — it is effectively undeletable.

Faithful reproduction: a REAL on-disk transcript at the real (sandboxed)
``claude_projects_dir``, a REAL AgenticProcess entity in the session SQLite DB,
and the REAL entity delete the trash button triggers. No mocks. The two
post-delete asserts fail today (the session is still found) and pass once delete
also removes/tombstones the on-disk session.
"""

from __future__ import annotations

import os
import time
import uuid

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin import worker_history as wh
from flow_sdk.builtin.faas.scan_actions import _resolve_session_record
from flow_sdk.instance_settings import get_instance_settings
from tests.unit.conftest import write_claude_transcript


def _worker_ids(entries) -> set[str]:
    return {e.worker_id for e in entries}


async def _make_and_delete_chat() -> str:
    """Create a real on-disk transcript + AgenticProcess for one chat, confirm it
    is found by both read paths, then issue the real trash-button delete. Returns
    the worker session id so each test can assert how it lingers."""
    sid = str(uuid.uuid4())  # v4 — a real Claude session id

    # Real on-disk transcript under the real claude_projects_dir. Non-scratch
    # encoded dir + cwd so the worker-history scratch filter keeps it;
    # mtime = now → it sorts to the top of the history slice.
    projects_dir = get_instance_settings().claude_projects_dir
    proj = projects_dir / "-Users-alice-Documents-dev-flowpad-oss"
    proj.mkdir(parents=True, exist_ok=True)
    jsonl = write_claude_transcript(proj, sid)
    now = time.time()
    os.utime(jsonl, (now, now))

    # Real AgenticProcess entity for that session (what the trash button targets).
    proc = AgenticProcess(
        id=str(uuid.uuid4()),
        session_id=sid,
        worker_type="claude_code",
        workdir="/Users/alice/Documents/dev/flowpad-oss",
        project_id=str(uuid.uuid4()),
        name="a chat to delete",
    )
    await proc.save()

    # Precondition: the session is present in BOTH read paths before delete.
    assert sid in _worker_ids(await wh.get_worker_history(limit=500)), (
        "precondition: session should be in history"
    )
    assert await AgenticProcess.get_by_session_id(sid) is not None
    assert _resolve_session_record(sid, hint="claude")[0] is not None, (
        "precondition: resolver should find the on-disk session"
    )

    # The real delete the Chats trash button issues.
    await proc.delete()
    assert await AgenticProcess.get_by_id(proc.id) is None  # entity is gone
    return sid


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_deleted_chat_gone_from_worker_history():
    """The history list (Chats side-menu) must not show a deleted chat."""
    sid = await _make_and_delete_chat()

    after = await wh.get_worker_history(limit=500)
    assert sid not in _worker_ids(after), (
        "deleted chat still appears in worker-history (on-disk transcript re-emitted)"
    )


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_deleted_chat_not_resolvable_by_worker_session_id():
    """``getByWorkerId`` (fromWorkerSessionId) must not re-find a deleted chat:
    the on-disk resolver behind ``terminals/get_by_worker_id`` would otherwise
    re-materialize the process from the surviving transcript."""
    sid = await _make_and_delete_chat()

    rec_after, _ = _resolve_session_record(sid, hint="claude")
    assert rec_after is None, (
        "deleted chat still resolvable by worker session id "
        "(getByWorkerId would re-materialize it from the on-disk transcript)"
    )
