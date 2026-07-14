"""RemoteWorkerSession bundle roundtrip: pack → wipe the local row → unpack
re-materializes the live-session snapshot from its packed ``header.json`` —
the hub-optional wire path (same metadata-only contract as flowpad_diagnosis).
Also pins the merge discipline at the unpack seam: an existing host row (one
with ``host_process_id``) is never regressed by an inbound snapshot, and the
pack whitelist never leaks host-local fields. Real test DB, no mocks."""

from __future__ import annotations

import json
import zipfile

import pytest

from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
from flow_sdk.builtin.flow_message_bundle import (
    _pack_remote_worker_session_attachment,
    pack_bundle,
    unpack_bundle,
)
from flow_sdk.builtin.remote_worker_session import (
    RemoteWorkerSession,
    RemoteWorkerSessionStatus as S,
)
from flow_sdk.schema.types import EntityType

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

FM_ID = "f5f5f5f5-0000-4000-8000-0000000000e1"
CONV_ID = "c0c0c0c0-0000-4000-8000-0000000000e2"


def _make_session(**over) -> RemoteWorkerSession:
    base = {
        "conversation_id": CONV_ID,
        "host_user_id": "host-hub-id",
        "guest_user_id": "guest-hub-id",
        "host_name": "Alice",
        "guest_name": "Bob",
        "status": S.IDLE.value,
        "last_activity_at": "2026-07-14T10:00:00+00:00",
        # Host-local — must NOT travel.
        "host_process_id": "ap-local-123",
        "project_id": "proj-local-1",
    }
    return RemoteWorkerSession(**{**base, **over})


def _session_fm(session_id: str, fm_id: str = FM_ID) -> FlowMessage:
    fm = FlowMessage(
        text="Live session turn",
        sender_name="Bob",
        attachment=[
            Attachment(
                attachment_type=AttachmentType.TYPE_ID,
                data=f"{EntityType.REMOTE_WORKER_SESSION.value}-{session_id}",
            )
        ],
    )
    fm.id = fm_id
    return fm


async def test_pack_unpack_session_roundtrip(tmp_path):
    rws = _make_session()
    await rws.save(notify=False)

    zip_path = await pack_bundle(_session_fm(rws.id), dest_dir=tmp_path)

    with zipfile.ZipFile(zip_path) as zf:
        header_name = f"attachment/{EntityType.REMOTE_WORKER_SESSION.value}-@{rws.id}/header.json"
        assert header_name in zf.namelist()
        header = json.loads(zf.read(header_name))
        assert header["id"] == rws.id
        assert header["status"] == S.IDLE.value
        # Host-local fields never leak into the wire snapshot.
        assert "host_process_id" not in header
        assert "project_id" not in header

    # Simulate a clean receiver: wipe the local row.
    await rws.delete()
    assert await RemoteWorkerSession.get_one({"id": rws.id}) is None

    await unpack_bundle(zip_path, local_user_id="receiver")

    restored = await RemoteWorkerSession.get_one({"id": rws.id})
    assert restored is not None
    assert restored.status == S.IDLE.value
    assert restored.conversation_id == CONV_ID
    assert restored.host_name == "Alice"
    assert restored.guest_name == "Bob"
    # Receiver's mirror has no host-local state.
    assert not restored.host_process_id
    assert not restored.project_id

    await restored.delete()


async def test_pack_header_is_exact_snapshot_whitelist(tmp_path):
    rws = _make_session()
    await rws.save(notify=False)

    attachment_dir = tmp_path / "attachment"
    attachment_dir.mkdir(parents=True, exist_ok=True)
    await _pack_remote_worker_session_attachment(rws.id, attachment_dir)

    header_path = (
        attachment_dir
        / f"{EntityType.REMOTE_WORKER_SESSION.value}-@{rws.id}"
        / "header.json"
    )
    assert header_path.exists()
    header = json.loads(header_path.read_text(encoding="utf-8"))
    # model_dump(include=...) drops declared-but-None fields only via the
    # include set; assert we never exceed the snapshot contract.
    assert set(header.keys()) <= set(RemoteWorkerSession.SNAPSHOT_FIELDS)
    assert header["type"] == EntityType.REMOTE_WORKER_SESSION.value

    # session-missing (get_one None) → no entry, pure no-op.
    missing_dir = tmp_path / "missing"
    missing_dir.mkdir(parents=True, exist_ok=True)
    missing_id = "f5f5f5f5-0000-4000-8000-0000000009e1"
    assert await RemoteWorkerSession.get_one({"id": missing_id}) is None
    await _pack_remote_worker_session_attachment(missing_id, missing_dir)
    assert list(missing_dir.iterdir()) == []

    await rws.delete()


async def test_unpack_never_regresses_host_row(tmp_path):
    """The host's own row (host_process_id set) must survive an inbound
    snapshot untouched — even a fresher one. Guest identity fields may
    fill-merge, host state may not."""
    sender = _make_session(status=S.ENDED.value,
                           last_activity_at="2026-07-14T12:00:00+00:00")
    await sender.save(notify=False)
    zip_path = await pack_bundle(
        _session_fm(sender.id, fm_id="f5f5f5f5-0000-4000-8000-0000000000e3"),
        dest_dir=tmp_path,
    )
    await sender.delete()

    host_row = _make_session(status=S.RUNNING.value,
                             last_activity_at="2026-07-14T09:00:00+00:00",
                             guest_name=None)
    host_row.id = sender.id
    await host_row.save(notify=False)

    await unpack_bundle(zip_path, local_user_id="host")

    after = await RemoteWorkerSession.get_one({"id": sender.id})
    assert after is not None
    assert after.status == S.RUNNING.value          # not regressed to ENDED
    assert after.host_process_id == "ap-local-123"  # host-local state intact
    assert after.guest_name == "Bob"                # identity fill-merge OK

    await after.delete()


async def test_unpack_guest_row_adopts_fresher_snapshot(tmp_path):
    sender = _make_session(status=S.ENDED.value,
                           last_activity_at="2026-07-14T12:00:00+00:00")
    await sender.save(notify=False)
    zip_path = await pack_bundle(
        _session_fm(sender.id, fm_id="f5f5f5f5-0000-4000-8000-0000000000e4"),
        dest_dir=tmp_path,
    )
    await sender.delete()

    guest_row = RemoteWorkerSession(
        id=sender.id, conversation_id=CONV_ID, status=S.IDLE.value,
        last_activity_at="2026-07-14T10:00:00+00:00",
    )
    await guest_row.save(notify=False)

    await unpack_bundle(zip_path, local_user_id="guest")

    after = await RemoteWorkerSession.get_one({"id": sender.id})
    assert after is not None
    assert after.status == S.ENDED.value            # fresher clock adopted
    assert not after.host_process_id                # never synthesized

    await after.delete()
