"""A shared .flowmsg bundle must carry the message's real send-time.

``_FM_FIELDS`` is the allow-list of fields packed into the bundle header. It
omitted ``created_date``/``updated_date``, so the sender never shipped the
send-time and the receiver (unpack → ``materialize_flow_message``) defaulted it
to ``now()``. Because a conversation's recency is ``max(message.updated_date)``,
every re-synced conversation collapsed to the sync instant — so the inbox /
side-panel list lost its order.

These tests drive the REAL pack → unpack → persisted-row path. The two local
tests are the control: a never-shared conversation keeps its real dates, so the
bug is hub-bundle-specific.
"""

from __future__ import annotations

import json
import zipfile
from datetime import datetime, timezone

import pytest

from flow_sdk.app.actions.materialize_flow_message import materialize_flow_message
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.flow_message_bundle import pack_bundle, unpack_bundle
from flow_sdk.fs_store.operations.conversation import (
    default_jsonl_path,
    from_jsonl,
    project_pointers_to_entity,
)
from flow_sdk.fs_store.record_types import RecordType


# A clearly-past send-time; 2020 makes any "stamped to now()" regression obvious.
_PAST = datetime(2020, 1, 15, 10, 0, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _records_root(monkeypatch, tmp_path):
    """Pin the conversation .jsonl path under tmp."""
    monkeypatch.setattr(
        "flow_sdk.fs_store.record_paths.get_default_records_data_root",
        lambda: tmp_path,
    )


def _ids(n: int) -> tuple[str, str]:
    """A distinct (fm_id, conv_id) pair per test. The session-scoped test DB
    persists rows across tests, and unpacking a FlowMessage id that already
    exists raises ``FlowMessageExistsError`` — unrelated to the date bug."""
    return (
        f"f00d{n:04d}-1111-4111-8111-{n:012d}",
        f"cafe{n:04d}-1111-4111-8111-{n:012d}",
    )


def _sent_message(fm_id: str, conv_id: str) -> FlowMessage:
    """A text-only message as it exists on the SENDER, with a real past send-time."""
    fm = FlowMessage(
        text="a message Nir sent weeks ago",
        shared_context_entities=[{"type": "conversation", "id": conv_id}],
        attachment=[],
        sender_name="Nir Levy",
        conversation_id=conv_id,
    )
    fm.id = fm_id
    fm.created_date = _PAST
    fm.updated_date = _PAST
    return fm


async def _pack(n: int, tmp_path):
    """Pack a past-dated message; return (fm_id, conv_id, zip_path)."""
    fm_id, conv_id = _ids(n)
    zip_path = await pack_bundle(_sent_message(fm_id, conv_id), dest_dir=tmp_path)
    return fm_id, conv_id, zip_path


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_bundle_header_carries_send_time(tmp_path):
    """The defect itself: packing a message must keep its created/updated date in
    the bundle header, else the receiver has nothing to restore."""
    _, _, zip_path = await _pack(1, tmp_path)

    with zipfile.ZipFile(zip_path) as zf:
        header = json.loads(zf.read("header.json"))

    assert header.get("created_date") is not None, (
        "bundle header dropped created_date — the sender never ships the "
        "message's send-time (_FM_FIELDS omits it)"
    )
    assert header.get("updated_date") is not None, "bundle header dropped updated_date"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_unpacked_message_keeps_send_time(tmp_path):
    """Pack a past-dated message, unpack via the production function, then query
    the persisted row: it must keep the 2020 send-time, not be re-stamped to now()."""
    fm_id, _, zip_path = await _pack(2, tmp_path)
    await unpack_bundle(zip_path, "local-user-id")

    fm = await FlowMessage.get_one({"id": fm_id})
    assert fm is not None, "message was not materialised on unpack"
    assert Conversation._as_datetime(fm.updated_date) == _PAST, (
        f"unpacked message updated_date re-stamped to {fm.updated_date!r}"
    )
    assert Conversation._as_datetime(fm.created_date) == _PAST, (
        f"unpacked message created_date re-stamped to {fm.created_date!r}"
    )


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_unpacked_conversation_keeps_recency(tmp_path):
    """The real symptom: after unpack the Conversation's ``updated_date`` (what
    the inbox sorts on) must be the true last-message time, not the sync instant."""
    _, conv_id, zip_path = await _pack(3, tmp_path)
    await unpack_bundle(zip_path, "local-user-id")

    conv = await Conversation.get_one({"id": conv_id})
    assert conv is not None, "conversation was not materialised on unpack"
    assert Conversation._as_datetime(conv.updated_date) == _PAST, (
        f"conversation recency collapsed to {conv.updated_date!r} (the sync instant) — "
        f"this is what makes the side-panel list noisy and unordered"
    )


# ---------------------------------------------------------------------------
# Control: a purely local conversation (never shared) keeps its real dates on
# re-sync. ``conversation`` is a runtime-only type with no indexer walker, so the
# indexer never bare-reindexes it; every real re-sync path pairs ``sync_to_db``
# with ``project_pointers_to_entity``, which re-derives recency from the
# unchanged local messages. These tests drive that paired path.
# ---------------------------------------------------------------------------


async def _seed_local_conversation(fm_id: str, conv_id: str) -> Conversation:
    """A local-origin conversation (remote stays False) with one past-dated
    message, written through the real local-send path."""
    fm = await materialize_flow_message(
        {
            "id": fm_id,
            "text": "a note I wrote weeks ago",
            "conversation_id": conv_id,
            "created_date": _PAST.isoformat(),
            "updated_date": _PAST.isoformat(),
        },
        conversation_id=conv_id,
        someone_typeid=None,
        bundle_ts=_PAST.isoformat(),
        notify=False,
        remote=False,
    )
    assert fm is not None
    conv = await Conversation.get_one({"id": conv_id})
    assert conv is not None and not conv.remote, "fixture must be a local conversation"
    return conv


async def _resync_conversation(conv_id: str) -> None:
    """Re-sync the conversation record exactly as production does: record → DB
    (``sync_to_db``) immediately followed by the pointer re-projection."""
    rec = from_jsonl(
        default_jsonl_path(conv_id),
        parent_id="", record_id=conv_id, parent_type=RecordType.PROJECT,
    )
    await rec.sync_to_db(notify=False)
    await project_pointers_to_entity(rec, notify=False)


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_local_conversation_resync_preserves_updated_date():
    """A never-shared conversation with a past message, re-synced, keeps its true
    last-message time — NOT overrun to the sync instant (control for the remote
    collapse above)."""
    fm_id, conv_id = _ids(4)
    conv = await _seed_local_conversation(fm_id, conv_id)
    assert Conversation._as_datetime(conv.updated_date) == _PAST, "fixture baseline wrong"

    await _resync_conversation(conv_id)

    conv2 = await Conversation.get_one({"id": conv_id})
    assert conv2 is not None
    assert Conversation._as_datetime(conv2.updated_date) == _PAST, (
        f"local conversation updated_date overrun to {conv2.updated_date!r} on re-sync"
    )


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_local_message_resync_preserves_dates():
    """The local message itself keeps its past created/updated date across a
    record → DB re-sync (the local analogue of the remote re-stamp bug)."""
    fm_id, conv_id = _ids(5)
    await _seed_local_conversation(fm_id, conv_id)

    await _resync_conversation(conv_id)

    fm = await FlowMessage.get_one({"id": fm_id})
    assert fm is not None
    assert Conversation._as_datetime(fm.updated_date) == _PAST, (
        f"local message updated_date overrun to {fm.updated_date!r} on re-sync"
    )
