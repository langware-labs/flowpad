"""ClaudeSession bundle pack/unpack: the FILE-BACKED asset family path.

A session IS its transcript file, so ``claude_session`` declares a placement
(``asset_class="repo"`` / ``family="claude_session"``) and rides the ONE generic
``_pack_file_backed_attachment`` — the same lane as skill/spec/markdown. There is
no bespoke session packer, no separately-named transcript FILE attachment, and no
private received-transcripts store.

Two real-DB, no-mock tests:

  1. PACK — the transcript lands INSIDE the session's own entry dir at its
     declared subdir, identified structurally by the entry key. Nothing is
     written for a session that does not exist locally.

  2. UNPACK — the entry STAGES for review (``receive_policy`` is unset, so a
     transcript follows the normal dashed-chip → pick-a-project → install gate)
     rather than materializing a row at unpack time.

Real test DB + real pack/unpack code; no entity get_one/save patching.
"""

from __future__ import annotations

import zipfile

import pytest

from flow_sdk.builtin.claude_session import ClaudeSession
from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
from flow_sdk.builtin.flow_message_bundle import pack_bundle, unpack_bundle
from flow_sdk.builtin.message_attachment import MessageAttachment

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

SESS_ID = "5e551011-0000-4000-8000-000000000001"
MISSING_SESS_ID = "deadbeef-0000-4000-8000-00000000ffff"
FM_ID = "fa11fa11-0000-4000-8000-000000000001"

TRANSCRIPT_LINES = (
    '{"type":"user","message":{"role":"user","content":"hi"},"cwd":"/Users/alice/repo"}\n'
    '{"type":"assistant","message":{"role":"assistant","content":"hello"}}\n'
)


def _fm_with_session(fm_id: str, *extra_session_ids: str) -> FlowMessage:
    atts = [Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"claude_session-{SESS_ID}")]
    for sid in extra_session_ids:
        atts.append(Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"claude_session-{sid}"))
    fm = FlowMessage(text="check out this session", sender_name="Alice", attachment=atts)
    fm.id = fm_id
    return fm


async def _sender_session(tmp_path) -> ClaudeSession:
    """A local session whose ``asset_ref`` points at a real transcript file."""
    transcript = tmp_path / "src" / f"{SESS_ID}.jsonl"
    transcript.parent.mkdir(parents=True, exist_ok=True)
    transcript.write_text(TRANSCRIPT_LINES, encoding="utf-8")
    sess = ClaudeSession(
        name="Sender Session",
        slug="sender-slug",
        message_count=7,
        cwd="/Users/alice/secret/repo",
        worker_session_id="worker-abc-123",
        asset_ref=str(transcript),
    )
    sess.id = SESS_ID
    await sess.save(notify=False)
    return sess


async def test_pack_puts_transcript_inside_the_session_entry(tmp_path):
    """The bytes travel inside ``attachment/claude_session-<id>/`` — so the
    receiver identifies them by the entry key, never by sniffing a filename or
    grepping file contents for the session id."""
    await _sender_session(tmp_path)

    # A second attachment points at a session that does NOT exist locally: the
    # generic packer's source-miss must write no entry.
    fm = _fm_with_session(FM_ID, MISSING_SESS_ID)
    zip_path = await pack_bundle(fm, dest_dir=tmp_path)

    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()

    entry_prefix = f"attachment/claude_session-{SESS_ID}/"
    carried = [n for n in names if n.startswith(entry_prefix)]
    assert carried, f"no entry dir for the session; got {names}"

    # The transcript rides at the type's declared subdir inside the entry.
    transcript_entries = [n for n in carried if n.endswith(".jsonl")]
    assert transcript_entries, f"transcript not carried inside the entry: {carried}"
    assert any("agentic-assets/claude_session/" in n for n in transcript_entries), transcript_entries

    # It is NOT smuggled through the raw-file lane under a transport name.
    assert not any(n.startswith("attachment/files/") for n in names), names
    assert not any(n.endswith("attachment/files/conversation.jsonl") for n in names), names

    # Source-miss → nothing written for the session that does not exist locally.
    assert not any(f"claude_session-{MISSING_SESS_ID}" in n for n in names)


async def test_unpack_stages_for_review_instead_of_auto_installing(tmp_path):
    """``claude_session`` no longer declares ``receive_policy='auto'``: unpack
    stages a MessageAttachment and STOPS. The row is materialized only by the
    explicit install action, once the user has picked a scope/project."""
    sess = await _sender_session(tmp_path)
    zip_path = await pack_bundle(_fm_with_session(FM_ID), dest_dir=tmp_path)

    # Clean receiver: no local row for this session.
    await sess.delete()
    assert await ClaudeSession.get_one({"id": SESS_ID}) is None

    await unpack_bundle(zip_path, local_user_id="receiver")

    # Staged for review…
    mas = await MessageAttachment.get_all({"flow_message_id": FM_ID})
    staged = [m for m in mas if m.asset_type == "claude_session"]
    assert staged, f"unpack did not stage the session entry; got {[m.asset_type for m in mas]}"
    assert staged[0].installed_at is None, "session auto-installed despite the review gate"

    # …and NOT installed: no entity row until the user chooses.
    assert await ClaudeSession.get_one({"id": SESS_ID}) is None, (
        "unpack materialized the row — the review gate was bypassed"
    )
