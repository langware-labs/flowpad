"""Deleting a project must reap its workers' OS processes, not just the rows.

The 9007 fallout: ``Project._delete_with_children`` destroys each
agentic_process/shell record via ``FSRecord.destroy()`` (DB row + shadow) but
never went through the worker-teardown seam. The codex/claude OS child kept
running after its row was gone — an orphaned worker holding its session's JSONL
writer lock, so a later ``resume`` of that session collided
("thread already has an active writer") and stalled.

Faithful + fast: a REAL OS child stands in for the worker (a plain ``sleep``
subprocess — no PTY/codex needed, and no mock of the unit under test), bound to
a real Shell via ``worker_pid`` exactly as ``start_pty`` records it. Deleting
the project must leave that pid dead.

# do not increase timeout without approval
"""
from __future__ import annotations

import subprocess

import psutil
import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.shell import Shell


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_project_delete_kills_worker_process() -> None:
    # A real, long-lived OS child standing in for the worker.
    worker = subprocess.Popen(["sleep", "60"])
    try:
        assert psutil.pid_exists(worker.pid)

        project = Project(name="/tmp/flowpad-worker-reap-test")
        await project.save()

        shell = Shell(worker_pid=worker.pid, status="running")
        await shell.save()

        proc = AgenticProcess(
            shell_id=shell.id,
            project_id=project.id,
            visible=True,
        )
        await proc.save()

        # Delete the project the way the UI does.
        await project._delete_with_children()

        # Give the SIGTERM path a beat to reap the child, then assert it is gone.
        try:
            worker.wait(timeout=5)  # do not increase timeout without approval
        except subprocess.TimeoutExpired:
            pass
        assert not psutil.pid_exists(worker.pid), (
            "project delete left the worker OS process alive (orphaned worker "
            "leak — it keeps holding its session writer lock)"
        )
    finally:
        if worker.poll() is None:
            worker.kill()
            worker.wait(timeout=5)
