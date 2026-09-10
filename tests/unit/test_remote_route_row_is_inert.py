"""A route row (``hub_route=True``) is inert to every local lifecycle mechanism.

A process opened on a remote deployment lives on that machine; the local row is a
same-id routing handle adopted from the hub (the ``Deployment.adopt_from_hub``
pattern). It carries the hub's projection of the process, never a worker. Every
caller-less mechanism that acts on process rows — the boot orphan sweep, the queue
drain, headless reuse, the transcript subscriber, the serializer's transcript and
folder synthesis, ``save()``'s restart-hash recompute — selects rows with an
unfiltered ``get_all()`` and would otherwise treat the handle as a dead, cold, or
stale local worker.

Real entities, real DB (session SQLite fixture + per-test records root from
tests/conftest.py). Each case monkeypatches the local side effect to RAISE, so a
guard that stops holding is a failure, not a silent no-op.
"""

import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.process_lifecycle import ProcessStatus
from flow_sdk.builtin.worker_status import WorkerStatus
from flow_sdk.server.pty_recovery import reconcile_orphaned_workers

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

TARGET = "agent-11111111-1111-4111-8111-111111111111"
PROJECTION = {
    "worker_status": "working",
    "worker_status_detail": None,
    "worker_status_detail_id": None,
    "busy": True,
    "ready_for_input": False,
    "queue": {"enabled": True, "entries": [{"id": "q1", "prompt": "remote-queued"}]},
    "total_cost_usd": 0.42,
}


def _boom(*_a, **_k):
    raise AssertionError("a remote route row must never reach the local worker machinery")


async def _remote_row(**overrides) -> AgenticProcess:
    row = AgenticProcess(
        id=str(uuid.uuid4()),
        hub_route=True,
        remote=True,
        status=ProcessStatus.RUNNING.value,
        pty_mode=False,
        visible=True,
        target_typeid_str=TARGET,
        session_id=overrides.pop("session_id", f"sess-{uuid.uuid4()}"),
        deployment_id=str(uuid.uuid4()),
        context_data={"remote_projection": dict(PROJECTION)},
        **overrides,
    )
    await row.save()
    return row


@pytest.mark.asyncio
async def test_boot_orphan_sweep_leaves_a_remote_row_running():
    """The sweep stamps dead headless RUNNING rows STOPPED. A route row is
    headless-shaped and RUNNING by projection — and its worker is alive, elsewhere."""
    row = await _remote_row()
    await reconcile_orphaned_workers()
    loaded = await AgenticProcess.get_by_id(row.id)
    assert loaded.status == ProcessStatus.RUNNING.value


@pytest.mark.asyncio
async def test_save_never_recomputes_the_restart_hash_of_a_remote_row(monkeypatch):
    row = await _remote_row(last_started_hash="hub-owned-hash")
    monkeypatch.setattr(AgenticProcess, "_restart_reference_hash", _boom)
    monkeypatch.setattr(AgenticProcess, "_restart_snapshot", _boom)
    row.name = "renamed"
    await row.save()
    loaded = await AgenticProcess.get_by_id(row.id)
    assert loaded.last_started_hash == "hub-owned-hash"
    assert loaded.restart_required is False


@pytest.mark.asyncio
async def test_serializer_reads_the_projection_and_never_the_transcript_or_disk(monkeypatch):
    """``model_dump`` is the universal currency (persistence, WS broadcast, REST).
    For a route row every derived axis comes from the hub's projection."""
    row = await _remote_row()
    monkeypatch.setattr(AgenticProcess, "_discover_status_from_transcript", _boom)
    monkeypatch.setattr(AgenticProcess, "_queue_state", _boom)
    monkeypatch.setattr(AgenticProcess, "_record_dir", _boom)

    data = row.model_dump(mode="json")

    assert data["worker_status"] == "working"
    assert data["busy"] is True
    assert data["ready_for_input"] is False
    assert data["queue"]["entries"][0]["prompt"] == "remote-queued"
    assert data["total_cost_usd"] == 0.42
    assert data["remote"] is True
    for folder in ("exe_folder", "input_folder", "output_folder", "assets_folder"):
        assert not data.get(folder), f"{folder} must not be synthesized from the local record dir"


@pytest.mark.asyncio
async def test_queue_drain_never_cold_starts_a_remote_row(monkeypatch):
    """The drain admits a cold headless row for its first prompt — the exact
    shape of a route row. It must not inject, pop, or spawn."""
    row = await _remote_row()
    row.queue.enqueue("local-stray", source="test")  # a stray local file must still be inert
    monkeypatch.setattr(AgenticProcess, "headless_prompt", _boom, raising=False)
    monkeypatch.setattr(AgenticProcess, "start_pty", _boom)
    monkeypatch.setattr(AgenticProcess, "prompt", _boom)

    await row._maybe_drain_queue("test")
    row._schedule_queue_drain("test")

    assert [e["prompt"] for e in row.queue.read()["entries"]] == ["local-stray"]


@pytest.mark.asyncio
async def test_headless_reuse_never_adopts_a_remote_row():
    from flow_sdk.app.actions.execute_prompt import _reuse_or_spawn_headless

    remote = await _remote_row()
    spawned = await _reuse_or_spawn_headless(TARGET, workdir=str(Path.cwd()))
    assert spawned.id != remote.id
    assert spawned.hub_route is False
    loaded = await AgenticProcess.get_by_id(remote.id)
    assert loaded.visible is True and loaded.pty_mode is False  # untouched


@pytest.mark.asyncio
async def test_transcript_subscriber_skips_remote_rows(monkeypatch, tmp_path):
    from flow_sdk.builtin.agentic_process.transcript_subscriber import _route_to_ap

    row = await _remote_row(session_id=f"shared-{uuid.uuid4()}")
    monkeypatch.setattr(AgenticProcess, "on_transcript_change", _boom)
    await _route_to_ap(row.session_id, tmp_path / "t.jsonl", [])
