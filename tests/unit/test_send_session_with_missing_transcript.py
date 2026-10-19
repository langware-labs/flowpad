"""A session whose transcript is gone must be refused at send, not shipped empty.

FLOWPAD-2153. Sharing a session attaches ``claude_session-<id>`` and the bundle packer
copies the transcript from the session row's ``asset_ref``. When the row has no usable
file — Claude Code deletes transcripts after ~30 days while flowpad's index row lives on
(454 of 712 rows on one real machine), and a process that never had a turn has a session id
but no transcript at all (62 of the 65 recent no-transcript processes on that machine lived
under a minute) — the packer writes
NOTHING for the entry and says nothing: it returns early in
``_pack_file_backed_attachment`` (no row) or after ``serializer().render()`` yields None
(row, no file). The sender is told the send succeeded, the hub marks the body ``ready``,
and every recipient downloads a bundle that cannot be complete.

The receiver already treats every TYPE_ID attachment outside ``_NON_MATERIALIZING_TYPE_IDS``
as something the bundle must carry (``_type_id_attachment_present``). The sender must hold
itself to the same contract BEFORE the message exists: ``handle_add_message`` refuses the send
and names what cannot be shipped.

Real send handler, real entities, real packer — an offline local conversation, no mocks
(same shape as ``test_send_own_message_is_read``).

# do not increase timeout without approval
"""

from __future__ import annotations

import uuid
import zipfile

import pytest

from flow_sdk.app.actions.notification_action import handle_add_message
from flow_sdk.builtin.claude_session import ClaudeSession
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.flow_message_bundle import pack_bundle
from flow_sdk.fs_store.record_paths import (
    get_default_records_data_root,
    get_default_records_root,
    set_default_records_data_root,
    set_default_records_root,
)

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

_SENDER = f"user-{uuid.uuid4()}"
_TRANSCRIPT = '{"type":"user","message":{"role":"user","content":"hi"}}\n'


@pytest.fixture
def records_root(tmp_path):
    orig_root, orig_data = get_default_records_root(), get_default_records_data_root()
    set_default_records_root(tmp_path)
    set_default_records_data_root(tmp_path)
    try:
        yield tmp_path
    finally:
        set_default_records_root(orig_root)
        set_default_records_data_root(orig_data)


async def _conversation() -> str:
    conv_id = str(uuid.uuid4())
    await Conversation.model_validate({"id": conv_id, "remote": False}).save(None)
    return conv_id


async def _session(tmp_path, *, file_present: bool) -> str:
    sid = str(uuid.uuid4())
    path = tmp_path / "claude-projects" / f"{sid}.jsonl"
    if file_present:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(_TRANSCRIPT, encoding="utf-8")
    row = ClaudeSession(name="shared", slug=f"s-{sid[:8]}", asset_ref=str(path))
    row.id = sid
    await row.save(notify=False)
    return sid


async def _send(conv_id: str, *refs: str):
    return await handle_add_message(
        {"conversation_id": conv_id, "message": "look at this", "asset_references": list(refs)}, _SENDER
    )


async def _messages(conv_id: str) -> list:
    return await FlowMessage.get_all({"conversation_id": conv_id})


def _refused(resp) -> bool:
    return getattr(resp, "status", None) == "FAIL" or getattr(resp, "status_code", 200) >= 400


async def test_a_session_whose_transcript_file_is_gone_is_refused(records_root):
    """Row present, file gone: the state 64% of one real machine's sessions are in."""
    conv_id = await _conversation()
    sid = await _session(records_root, file_present=False)

    resp = await _send(conv_id, f"claude_session-{sid}")

    assert _refused(resp), (
        f"the send was accepted although claude_session-{sid[:8]} has no transcript on this "
        "machine — the recipient would get a bundle without it, and nobody is told"
    )
    assert f"claude_session-{sid}" in str(getattr(resp, "message", "")), "the refusal names what cannot be shipped"
    assert await _messages(conv_id) == [], "a refused send leaves no message behind"


async def test_a_session_with_no_row_and_no_findable_transcript_is_refused(records_root):
    """No row and nothing for the best-effort indexing to find."""
    conv_id = await _conversation()
    ghost = str(uuid.uuid4())

    resp = await _send(conv_id, f"claude_session-{ghost}")

    assert _refused(resp)
    assert await _messages(conv_id) == []


async def test_a_session_with_its_transcript_is_accepted_and_actually_ships(records_root):
    """The control, and the contract: whatever is accepted at send is what the packer ships."""
    conv_id = await _conversation()
    sid = await _session(records_root, file_present=True)

    resp = await _send(conv_id, f"claude_session-{sid}")

    assert not _refused(resp), getattr(resp, "message", resp)
    [fm] = await _messages(conv_id)
    zip_path = await pack_bundle(fm, dest_dir=records_root)
    with zipfile.ZipFile(zip_path) as zf:
        assert any(f"claude_session-{sid}" in n and n.endswith(".jsonl") for n in zf.namelist())


async def test_types_the_receiver_never_expects_in_a_bundle_are_not_refused(records_root):
    """``project`` rides a membership grant and is deliberately never packed; refusing it would
    break project invites. The sender holds itself to exactly the receiver's contract — no more."""
    conv_id = await _conversation()

    resp = await _send(conv_id, f"project-{uuid.uuid4()}")

    assert not _refused(resp), getattr(resp, "message", resp)


@pytest.mark.parametrize("state", ["no_row", "row_file_gone", "row_and_file"])
async def test_the_preflight_and_the_packer_agree(records_root, state):
    """The pairing the preflight relies on: it reports a gap exactly when the packer ships nothing.

    ``attachments_that_would_ship_nothing`` mirrors the packer's silent returns; this is what keeps
    the two from drifting apart — a packer change that ships (or drops) differently fails here.
    """
    from flow_sdk.builtin.flow_message import Attachment, AttachmentType
    from flow_sdk.builtin.flow_message_bundle import attachments_that_would_ship_nothing
    from flow_sdk.fs_store.type_id import TypeId

    sid = str(uuid.uuid4()) if state == "no_row" else await _session(records_root, file_present=state == "row_and_file")
    ref = f"claude_session-{sid}"

    fm = FlowMessage(
        text="x", sender_name="A", attachment=[Attachment(attachment_type=AttachmentType.TYPE_ID, data=ref)]
    )
    fm.id = str(uuid.uuid4())
    with zipfile.ZipFile(await pack_bundle(fm, dest_dir=records_root)) as zf:
        shipped = any(ref in n and n.endswith(".jsonl") for n in zf.namelist())

    gaps = await attachments_that_would_ship_nothing([TypeId(ref)])
    assert bool(gaps) == (not shipped), f"state={state}: preflight gaps={gaps!r} but the packer shipped={shipped}"


# --- the preflight: ask BEFORE anything is created ---------------------------------------------


async def test_the_preflight_names_what_would_arrive_empty_and_creates_nothing(records_root):
    """The share dialog asks this before it creates a conversation and invites anyone, so it must
    report the gap and leave no message and no conversation behind."""
    from flow_sdk.app.actions.notification_action import find_unshippable_references

    gone = await _session(records_root, file_present=False)
    ghost = str(uuid.uuid4())
    fine = await _session(records_root, file_present=True)
    refs = [f"claude_session-{gone}", f"claude_session-{ghost}", f"claude_session-{fine}", f"project-{uuid.uuid4()}"]
    conversations_before = len(await Conversation.get_all({}))
    messages_before = len(await FlowMessage.get_all({}))

    gaps = await find_unshippable_references(refs)

    assert sorted(str(tid) for tid, _ in gaps) == sorted([f"claude_session-{gone}", f"claude_session-{ghost}"])
    assert all(reason for _, reason in gaps), "each gap says why"
    assert len(await Conversation.get_all({})) == conversations_before, "the preflight created a conversation"
    assert len(await FlowMessage.get_all({})) == messages_before, "the preflight created a message"


async def test_the_preflight_agrees_with_the_send(records_root):
    """Whatever the preflight clears, the send accepts — and whatever it flags, the send refuses."""
    from flow_sdk.app.actions.notification_action import find_unshippable_references

    for file_present in (True, False):
        sid = await _session(records_root, file_present=file_present)
        ref = f"claude_session-{sid}"
        flagged = bool(await find_unshippable_references([ref]))
        refused = _refused(await _send(await _conversation(), ref))
        assert flagged == refused == (not file_present), (
            f"file_present={file_present}: flagged={flagged} refused={refused}"
        )


async def test_the_preflight_ignores_malformed_and_repeated_refs(records_root):
    from flow_sdk.app.actions.notification_action import find_unshippable_references

    sid = await _session(records_root, file_present=False)
    ref = f"claude_session-{sid}"

    gaps = await find_unshippable_references(["", "not a typeid", ref, ref])

    assert [str(tid) for tid, _ in gaps] == [ref], "one gap, however often it is listed, and junk is skipped"
