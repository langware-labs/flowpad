"""A redundant pull must not tear down a staging tree that is already complete.

FLOWPAD-2153. The auto-pull on conversation-open and the user's own Download
click land on the same message within the same second. The second pull adds
nothing, but re-unpacking REPLACES the staging tree wholesale: ``_persist_staging``
calls ``materialize_asset_sync(tmp_root, unpacked_dir, overwrite=True)``, which
moves the live ``unpacked/`` aside and renames a fresh copy into its place.

That teardown is the root cause of the user-visible bug. The serializer's body
probe is TWO independent disk reads — ``is_body_unpacked()`` stats
``unpacked/flow_message.json``, ``_type_id_attachment_present()`` stats
``unpacked/attachment/<key>`` — so a serialization landing inside the swap
answers the first from the old tree and the second from the gap, publishing
``body_downloaded=true`` together with ``body_missing_attachments=[session]``.
That pair renders the "pulled, but arrived short" warning AND filters the
attachment chip out of the bubble (``FlowMessageBubble.tsx`` → ``otherEntities``
drops anything ``isAttachmentMissing``), so the review dialog that owns
"Select project" becomes unreachable. A reload cleared it — the settled tree
probes fine.

This test asserts the CAUSE, not the timing: the staged tree must survive a
redundant pull intact. Asserting the contradictory serialization directly would
mean racing a microsecond-wide window, which is a coin flip dressed up as a
test; the teardown that opens that window is deterministic, and it is the thing
the fix removes. Tree identity is read from the inode, so a same-path rebuild is
caught even when the bytes are identical.

Real bundle from the real packer, real pull chokepoint, real unpack. The ONLY
seam is ``hub_get`` — the network boundary — serving the real bundle's bytes
from disk instead of a remote hub. The fault is never simulated.

# do not increase timeout without approval
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.app.actions.flow_message_action import _download_and_unpack_bundle
from flow_sdk.builtin.claude_session import ClaudeSession
from flow_sdk.builtin.flow_message import Attachment, AttachmentType, BodyStatus, FlowMessage
from flow_sdk.builtin.flow_message_bundle import pack_bundle
from flow_sdk.fs_store.operations.flow_message import staged_entry_dir, unpacked_dir

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(60)]  # do not increase timeout without approval

SESS_ID = "5e551011-0000-4000-8000-0000215300c1"
FM_ID = "fa11fa11-0000-4000-8000-0000215300c1"
SESSION_REF = f"claude_session-{SESS_ID}"

TRANSCRIPT = (
    '{"type":"user","message":{"role":"user","content":"hi"},"cwd":"/Users/alice/repo"}\n'
    '{"type":"assistant","message":{"role":"assistant","content":"hello"}}\n'
)


async def _real_bundle_bytes(tmp_path) -> bytes:
    """Pack a REAL .flowmsg carrying a real transcript, then clear the sender
    state so the receiver starts clean — exactly what arrives over the wire."""
    transcript = tmp_path / "src" / f"{SESS_ID}.jsonl"
    transcript.parent.mkdir(parents=True, exist_ok=True)
    transcript.write_text(TRANSCRIPT, encoding="utf-8")
    sess = ClaudeSession(name="Shared Session", slug="shared", asset_ref=str(transcript))
    sess.id = SESS_ID
    await sess.save(notify=False)

    fm = FlowMessage(
        text="check out this session",
        sender_name="Alice",
        attachment=[Attachment(attachment_type=AttachmentType.TYPE_ID, data=SESSION_REF)],
    )
    fm.id = FM_ID
    zip_path = await pack_bundle(fm, dest_dir=tmp_path)
    await sess.delete()
    return zip_path.read_bytes()


def _tree_identity() -> tuple[int, int]:
    """Inodes of the staging root and of the session's entry — a rebuild at the
    same path mints new ones, so this catches the swap byte-identical copies hide."""
    return (
        unpacked_dir(FM_ID).stat().st_ino,
        staged_entry_dir(FM_ID, SESSION_REF).stat().st_ino,
    )


async def test_redundant_pull_leaves_the_staged_tree_intact(tmp_path):
    bundle = await _real_bundle_bytes(tmp_path)

    with patch(
        "flow_sdk.app.actions.flow_message_action.hub_get",
        AsyncMock(return_value=bundle),
    ) as hub:
        # Pull #1 — the automatic one fired when the conversation opens.
        assert await _download_and_unpack_bundle(FM_ID, "body.flowmsg", body_status=BodyStatus.READY)
        # Precondition read through state that predates the fix, so a failure
        # here can only ever be the bug and never a missing new method.
        fm = await FlowMessage.get_one({"id": FM_ID})
        assert fm is not None and fm.is_body_downloaded(), "pull #1 must report the bundle as downloaded"
        assert staged_entry_dir(FM_ID, SESSION_REF).is_dir(), "pull #1 must stage the session entry"
        before = _tree_identity()
        pulls_after_first = hub.await_count

        # Pull #2 — the user's Download click on a bundle already staged.
        await _download_and_unpack_bundle(FM_ID, "body.flowmsg", body_status=BodyStatus.READY)

    assert _tree_identity() == before, (
        "the redundant pull tore down and rebuilt the staging tree; during that swap "
        "the row serializes as body_downloaded=True with "
        f"body_missing_attachments=[{SESSION_REF}] — the 'arrived short' warning fires "
        "and the attachment chip is filtered out, so 'Select project' is unreachable"
    )
    assert hub.await_count == pulls_after_first, "a bundle already staged in full must not be re-fetched"
