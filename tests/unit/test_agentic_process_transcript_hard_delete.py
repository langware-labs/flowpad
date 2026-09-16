"""FLOWPAD-2019 regression: delete() must not leave the transcript readable.

Root cause (proven via code trace this session):
``AgenticProcess._tombstone_session_transcript``
(flow_sdk/builtin/agentic_process/agentic_process.py) does
``path.rename(tomb)`` where ``tomb = "<sid>.jsonl.deleted"`` -- never
``path.unlink()``. The rename is the on/off switch: swapping it for an
unlink() makes the transcript content actually vanish from disk; the rename
leaves the full conversation byte-for-byte recoverable under the ``.deleted``
suffix. Meanwhile the Chats trash-button confirmation dialog
(ui/src/components/chats-navigator/ChatsNavigator.tsx) tells the user
"This cannot be undone".

Faithful reproduction: a REAL on-disk transcript, a REAL AgenticProcess
entity, and the REAL entity delete the trash button triggers
(ChatsNavigator -> process.delete() -> AgenticProcess.delete()). No mocks.
"""

from __future__ import annotations

import os
import time
import uuid

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.instance_settings import get_instance_settings
from tests.unit.conftest import write_claude_transcript

SENTINEL = "hello world"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_deleted_chat_transcript_content_not_recoverable_on_disk():
    """"This cannot be undone" (ChatsNavigator.tsx) must mean the transcript's
    content is actually gone from disk -- not merely hidden behind a rename."""
    sid = str(uuid.uuid4())  # v4 -- a real Claude session id

    # Real on-disk transcript under the real claude_projects_dir, same shape
    # the Claude driver's transcript resolver expects.
    projects_dir = get_instance_settings().claude_projects_dir
    proj = projects_dir / "-Users-alice-Documents-dev-flowpad-oss-2019"
    proj.mkdir(parents=True, exist_ok=True)
    jsonl = write_claude_transcript(proj, sid)
    now = time.time()
    os.utime(jsonl, (now, now))

    # Real AgenticProcess entity for that session (what the trash button targets).
    proc = AgenticProcess(
        id=str(uuid.uuid4()),
        session_id=sid,
        worker_type="claude_code",
        workdir="/Users/alice/Documents/dev/flowpad-oss-2019",
        project_id=str(uuid.uuid4()),
        name="a chat to hard-delete",
    )
    await proc.save()

    # The real delete the Chats trash button issues -- the UI promises the
    # user this "cannot be undone".
    await proc.delete()
    assert await AgenticProcess.get_by_id(proc.id) is None  # entity is gone

    # No file left under the transcript's own project dir may still carry the
    # original conversation content.
    leftover = [p for p in proj.glob(f"{sid}*") if SENTINEL in p.read_text(encoding="utf-8")]
    assert not leftover, (
        f"deleted chat's transcript content is still readable on disk: {leftover} -- "
        "delete() must make it actually unrecoverable, matching its own UI's "
        "\"cannot be undone\" promise"
    )
