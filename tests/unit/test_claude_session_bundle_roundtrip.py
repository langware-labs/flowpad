"""ClaudeSession bundle pack/unpack: the DB-record (header.json) family path.

Two real-DB, no-mock tests (mirrors test_git_branch_bundle_roundtrip):

  1. PACK — ``_pack_claude_session_attachment`` writes a header.json whitelisted
     to exactly ``{id,type,name,slug,message_count}``; sender-local ``cwd`` /
     ``worker_session_id`` are STRIPPED. A get_one-miss writes no entry.

  2. UNPACK — the CLAUDE_SESSION branch in ``unpack_bundle`` materializes the row
     (stamped ``received=True`` / ``remote=False``), then on re-receive FILL-MERGES
     blank fields without clobbering receiver-set fields (``_fill_merge_entity``
     skip_keys + never-clobber-already-set), creating no duplicate row.

Real test DB + real pack/unpack code; no entity get_one/save patching.
"""
from __future__ import annotations

import json
import zipfile

import pytest

from flow_sdk.builtin.claude_session import ClaudeSession
from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
from flow_sdk.builtin.flow_message_bundle import pack_bundle, unpack_bundle

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

SESS_ID = "5e551011-0000-4000-8000-000000000001"
MISSING_SESS_ID = "deadbeef-0000-4000-8000-00000000ffff"
FM_ID = "fa11fa11-0000-4000-8000-000000000001"
FM_ID_2 = "fa11fa11-0000-4000-8000-000000000002"

CLAUDE_SESSION_WHITELIST = {"id", "type", "name", "slug", "message_count"}


def _fm_with_session(fm_id: str, *extra_session_ids: str) -> FlowMessage:
    atts = [Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"claude_session-{SESS_ID}")]
    for sid in extra_session_ids:
        atts.append(Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"claude_session-{sid}"))
    fm = FlowMessage(text="check out this session", sender_name="Alice", attachment=atts)
    fm.id = fm_id
    return fm


async def test_pack_claude_session_header_whitelist_strips_sender_local(tmp_path):
    # Sender-side row carries local-only fields that must NOT ride the wire.
    sess = ClaudeSession(
        name="Sender Session",
        slug="sender-slug",
        message_count=7,
        cwd="/Users/alice/secret/repo",
        worker_session_id="worker-abc-123",
    )
    sess.id = SESS_ID
    await sess.save(notify=False)

    # A second attachment points at a session that does NOT exist locally:
    # _pack_claude_session_attachment's get_one-miss must write no entry.
    fm = _fm_with_session(FM_ID, MISSING_SESS_ID)
    zip_path = await pack_bundle(fm, dest_dir=tmp_path)

    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
        header_name = f"attachment/claude_session-@{SESS_ID}/header.json"
        assert header_name in names

        header = json.loads(zf.read(header_name))
        # Exactly the whitelist — no more, no less.
        assert set(header.keys()) == CLAUDE_SESSION_WHITELIST, header
        assert header["id"] == SESS_ID
        assert header["type"] == "claude_session"
        assert header["name"] == "Sender Session"
        assert header["slug"] == "sender-slug"
        assert header["message_count"] == 7
        # Sender-local fields stripped.
        assert "cwd" not in header
        assert "worker_session_id" not in header

        # get_one-miss → no entry written for the missing session.
        assert not any(f"claude_session-@{MISSING_SESS_ID}" in n for n in names)


async def test_unpack_materializes_claude_session_and_fill_merges_on_re_receive(tmp_path):
    # Sender packs a session with a name/slug/count.
    sess = ClaudeSession(
        name="Sender Session",
        slug="sender-slug",
        message_count=7,
        cwd="/Users/alice/secret/repo",
        worker_session_id="worker-abc-123",
    )
    sess.id = SESS_ID
    await sess.save(notify=False)
    # Pack BOTH bundles from the pristine sender state (before any receiver
    # mutation) so each header carries the real name/slug/count.
    zip_path = await pack_bundle(_fm_with_session(FM_ID), dest_dir=tmp_path)
    zip_path_2 = await pack_bundle(_fm_with_session(FM_ID_2), dest_dir=tmp_path / "two")

    # Clean receiver: wipe the local row so the first unpack materializes it.
    await sess.delete()
    assert await ClaudeSession.get_one({"id": SESS_ID}) is None

    # --- First unpack: materialize the row, stamped received=True / remote=False.
    await unpack_bundle(zip_path, local_user_id="receiver")
    landed = await ClaudeSession.get_one({"id": SESS_ID})
    assert landed is not None, "first unpack did not materialize the claude_session row"
    assert landed.received is True
    assert landed.remote is False
    assert landed.name == "Sender Session"
    assert landed.slug == "sender-slug"
    assert landed.message_count == 7

    # Receiver edits a field (receiver-set), and clears another (now blank) to
    # prove the next re-receive fill-merges the blank but preserves the edit.
    landed.slug = "receiver-edited-slug"  # receiver-set → must survive re-receive
    landed.name = ""                      # blank → must be filled from the bundle
    await landed.save(notify=False)

    # --- Re-receive: a follow-up message re-attaches the SAME session. The
    # second FlowMessage has a distinct id so the unpack proceeds to the
    # fill-merge branch (rather than short-circuiting on the FM-exists guard).
    await unpack_bundle(zip_path_2, local_user_id="receiver")

    merged = await ClaudeSession.get_one({"id": SESS_ID})
    assert merged is not None
    # Blank field filled from the bundle header.
    assert merged.name == "Sender Session", "blank field was not fill-merged from bundle"
    # Receiver-set field NOT clobbered (never-clobber-already-set).
    assert merged.slug == "receiver-edited-slug", "re-receive clobbered receiver-set field"
    assert merged.message_count == 7
    assert merged.received is True
    assert merged.remote is False

    # No duplicate row created by the re-receive.
    rows = await ClaudeSession.get_all({"id": SESS_ID})
    assert len(rows) == 1, f"re-receive created a duplicate row: {len(rows)} rows"
