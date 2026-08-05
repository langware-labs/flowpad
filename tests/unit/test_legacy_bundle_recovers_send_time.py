"""A message from a pre-fix sender must end up with its real send-time.

``_FM_FIELDS`` gained ``created_date`` on 2026-06-30 (624103f99), but that only
fixed what NEW senders ship. Bundles packed by older builds carry no send-time and
are frozen that way on the hub forever — 81 of the 116 bundles on a real machine,
spanning 2026-05-19 to 2026-07-09. When one is downloaded, ``unpack_bundle`` falls
back to ``now()`` and the message lands stamped with the sync instant, which is
what throws the inbox order out.

Two independent routes recover the true time. These tests enter through a
different one each, so each pins its own fix:

  1. ``unpack_bundle`` — the bundle carries the send-time in its own
     ``conversation.jsonl`` pointer (verified 32/32 on the messages that landed in
     one real catch-up). The receiver used to download it, unpack it, and ignore it.

  2. ``_process_single_hub_message`` — the hub payload carries the true
     ``created_date``, but it cannot ride the LWW gate: the row's fresh ``now()``
     stamp always looks newer than the hub, so a staleness-gated repair is never
     reached and the wrong value defends itself. ``adopt_hub_created_date`` runs
     ahead of that gate, which is what ``Conversation`` already does.

Route 2's precondition is a bundle carrying NEITHER a header send-time NOR a
pointer index — a real shape (the sender's conversation had no local record, so
``_pack_conversation_attachment`` returned early). Such a bundle is unrecoverable
from its own contents, making the hub the only remaining source. That keeps the
two routes independent: fixing one cannot silently satisfy the other's test.
"""

from __future__ import annotations

import contextlib
import json
import zipfile
from datetime import datetime, timezone

import pytest

from flow_sdk.app.actions.flow_message_action import _process_single_hub_message
from flow_sdk.app.actions.materialize_flow_message import materialize_flow_message
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.flow_message_bundle import pack_bundle, unpack_bundle
from flow_sdk.fs_store.operations.conversation import (
    append_message_pointer,
    default_jsonl_path,
    from_jsonl,
)
from flow_sdk.fs_store.record_types import RecordType

# The message's real send-time, as the sender's pointer index recorded it.
_SENT_AT = datetime(2026, 7, 5, 7, 37, 15, tzinfo=timezone.utc)
_EARLIER = datetime(2026, 7, 5, 7, 30, 0, tzinfo=timezone.utc)
_TEXT = "I keep getting a notification about an agent taking too long"


def _ids(n: int) -> tuple[str, str, str]:
    """Distinct ids per test — the session-scoped DB persists rows across tests."""
    return (
        f"beef{n:04d}-1111-4111-8111-{n:012d}",
        f"cafe{n:04d}-1111-4111-8111-{n:012d}",
        f"face{n:04d}-1111-4111-8111-{n:012d}",
    )


@pytest.fixture(autouse=True)
def _records_root(monkeypatch, tmp_path):
    """Pin the conversation .jsonl path under tmp."""
    monkeypatch.setattr(
        "flow_sdk.fs_store.record_paths.get_default_records_data_root",
        lambda: tmp_path,
    )


def _legacy_sender_message(fm_id: str, conv_id: str) -> FlowMessage:
    """The message as it exists on the SENDER, carrying both TYPE_ID attachments.

    The self-referential ``flow_message-<own id>`` matters: it is what makes the
    packer emit ``attachment/flow_message-<id>/header.json``, and THAT entry — not
    the top-level header — is where the receiver's row is born. 103 of 108 real
    bundles on a live machine carry it. A fixture without it exercises a path the
    product almost never takes, and will pass with the fix deleted.
    """
    from flow_sdk.builtin.flow_message import Attachment, AttachmentType

    fm = FlowMessage(
        text=_TEXT,
        shared_context_entities=[{"type": "conversation", "id": conv_id}],
        attachment=[
            # Makes the packer ship the conversation's pointer index.
            Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"conversation-{conv_id}"),
            # Makes the packer ship the per-message entry the row is born from.
            Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"flow_message-{fm_id}"),
        ],
        sender_name="Shani Shuber",
        conversation_id=conv_id,
    )
    fm.id = fm_id
    return fm


@contextlib.contextmanager
def _sender_on_a_pre_fix_build(monkeypatch):
    """Pack as a client from before 2026-06-30 (``624103f99``) would have.

    That release added ``created_date``/``updated_date`` to ``_FM_FIELDS``. Before
    it, the packer simply had no such fields to ship — which is why 81 of 116 real
    bundles carry no send-time and are frozen that way on the hub forever.

    This narrows the SENDER's field list for the duration of the pack — modelling
    a genuinely older build, which is different software. The receiver code under
    test is untouched: nothing about unpack, materialize or the restore path is
    patched. Producing the artifact any other way is impossible here, because a
    saved row always gets a date stamped, so a current build cannot emit a
    dateless entry.
    """
    from flow_sdk.builtin import flow_message_bundle as bundle_mod

    monkeypatch.setattr(
        bundle_mod,
        "_FM_FIELDS",
        bundle_mod._FM_FIELDS - {"created_date", "updated_date"},
    )
    yield


async def _seed_sender_pointer_index(fm_id: str, conv_id: str, prior_id: str) -> None:
    """The sender's conversation + its pointer index, carrying the true send-time.

    An earlier message is materialised through the real local-send path so the
    Conversation row and its ``conversation.jsonl`` exist (``pack_bundle`` packs the
    index only for a conversation that has one). Our message's pointer is then
    appended through the production writer — this is the file the real affected
    bundles were found to carry, with the true send-time in it.
    """
    await materialize_flow_message(
        {
            "id": prior_id,
            "text": "an earlier message in the same thread",
            "conversation_id": conv_id,
            "created_date": _EARLIER.isoformat(),
            "updated_date": _EARLIER.isoformat(),
        },
        conversation_id=conv_id,
        someone_typeid=None,
        bundle_ts=_EARLIER.isoformat(),
        notify=False,
        remote=False,
    )
    rec = from_jsonl(
        default_jsonl_path(conv_id),
        parent_id="",
        record_id=conv_id,
        parent_type=RecordType.PROJECT,
    )
    append_message_pointer(rec, fm_id, _SENT_AT.isoformat())


async def _receive_legacy_bundle(n: int, tmp_path, monkeypatch, *, with_pointer_index: bool = True):
    """Pack a pre-fix bundle and receive it through the real unpack path.

    ``with_pointer_index=False`` models the sender whose conversation has no local
    record — ``_pack_conversation_attachment`` returns early for those, so the
    bundle ships neither a header send-time nor a pointer index. That bundle is
    genuinely unrecoverable from its own contents, which is what makes it the
    honest precondition for the hub-repair route.

    Asserts the artifact really has the shape claimed, so neither test can pass or
    fail against a fixture that isn't the real thing.
    """
    fm_id, conv_id, prior_id = _ids(n)
    if with_pointer_index:
        await _seed_sender_pointer_index(fm_id, conv_id, prior_id)

    # The sender HAS the row — ``_pack_flow_message_entry`` looks it up by id and
    # emits nothing for a message it can't find. Saving it is what makes the
    # per-message entry appear in the bundle at all.
    sender_fm = _legacy_sender_message(fm_id, conv_id)
    await sender_fm.save()
    with _sender_on_a_pre_fix_build(monkeypatch):
        zip_path = await pack_bundle(sender_fm, dest_dir=tmp_path)
    # The receiver does NOT have it. Drop the local row so unpack materializes it
    # fresh, which is the situation every affected message was actually in.
    await sender_fm.delete()

    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
        header_name = next(n_ for n_ in names if n_ in ("flow_message.json", "header.json"))
        header = json.loads(zf.read(header_name))
        jsonl_name = next((n_ for n_ in names if n_.endswith("conversation.jsonl")), None)
        assert not header.get("created_date"), "fixture is not a legacy bundle — the header carries a send-time"
        # The entry the row is actually born from — 103 of 108 real bundles have it.
        entry = next((n_ for n_ in names if n_.startswith("attachment/flow_message") and n_.endswith(".json")), None)
        assert entry, (
            "fixture is missing attachment/flow_message-<id>/header.json — without it "
            "the test exercises the top-level path, not the one the row is born from, "
            "and passes with the fix deleted"
        )
        assert not json.loads(zf.read(entry)).get("created_date"), (
            "the per-message entry carries a send-time — not a legacy bundle"
        )
        if with_pointer_index:
            assert jsonl_name, "fixture is not like the real bundles — no pointer index inside"
            ptr_ts = [
                json.loads(line)["ts"]
                for line in zf.read(jsonl_name).decode().splitlines()
                if line.strip() and fm_id in line
            ]
            assert ptr_ts and ptr_ts[0].startswith("2026-07-05T07:37:15"), (
                f"fixture pointer index lost the send-time: {ptr_ts}"
            )
        else:
            assert not jsonl_name, "fixture was meant to carry no pointer index"

    await unpack_bundle(zip_path, "local-user-id")
    return fm_id, conv_id, str(zip_path)


# ---------------------------------------------------------------------------
# Route 1 — entry point: unpack_bundle
# (real path: _process_single_hub_message -> _download_and_unpack_bundle -> here)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_legacy_bundle_message_keeps_its_send_time(tmp_path, monkeypatch):
    fm_id, _, _ = await _receive_legacy_bundle(1, tmp_path, monkeypatch)

    fm = await FlowMessage.get_one({"id": fm_id})
    assert fm is not None, "message was not materialised on unpack"
    assert Conversation._as_datetime(fm.created_date) == _SENT_AT, (
        f"a legacy bundle's message landed stamped {fm.created_date!r} instead of its "
        f"real send-time {_SENT_AT!r} — the send-time was inside the bundle "
        f"(conversation.jsonl pointer) and was ignored"
    )


# ---------------------------------------------------------------------------
# Route 2 — entry point: _process_single_hub_message
# (real path: handle_conversation_list -> _fetch_conversation_messages -> here)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_hub_sync_repairs_a_now_stamped_message(tmp_path, monkeypatch):
    """A row already damaged by route 1 must be healed by the next hub sync.

    ``Conversation`` has exactly this repair — "always-adopt the hub's created_date
    … repairs rows that were re-created locally with a bogus created_date"
    (flow_message_action.py:3373-3379). ``FlowMessage`` has no equivalent, and the
    LWW gate makes sure it never gets one by accident: the bogus ``now()`` stamp is
    newer than the hub's clock, so ``is_stale`` says "nothing to do".
    """
    fm_id, conv_id, _ = await _receive_legacy_bundle(2, tmp_path, monkeypatch, with_pointer_index=False)

    damaged = await FlowMessage.get_one({"id": fm_id})
    assert damaged is not None
    assert Conversation._as_datetime(damaged.created_date) != _SENT_AT, (
        "precondition: a bundle with neither a header send-time nor a pointer index "
        "is unrecoverable from its own contents, so the row must land stamped with "
        "the sync instant — the hub is the only remaining source"
    )

    # Exactly what the hub returns for this message in the conversation listing.
    # No ``attachment_filename`` — a text-only message, so this drives the real
    # handler with no network and nothing stubbed.
    raw = {
        "id": fm_id,
        "type": "flow_message",
        "text": _TEXT,
        "conversation_id": conv_id,
        "sender_name": "Shani Shuber",
        "created_date": _SENT_AT.isoformat(),
        "updated_date": _SENT_AT.isoformat(),
    }
    await _process_single_hub_message(raw)

    fm = await FlowMessage.get_one({"id": fm_id})
    assert fm is not None
    assert Conversation._as_datetime(fm.created_date) == _SENT_AT, (
        f"the hub sync left the message stamped {fm.created_date!r} instead of adopting "
        f"the hub's true send-time {_SENT_AT!r} — the local now() stamp makes the row "
        f"look newer than the hub, so the LWW gate at flow_message_action.py:1831 "
        f"returns before the merge that would repair it. The wrong value defends itself."
    )
