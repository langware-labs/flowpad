"""A received PromptCompletion reply is never reported as a missing attachment.

FLOWPAD-2153. A host answers a guest's prompt with a reply message that carries a
``prompt_completion-<id>`` TYPE_ID attachment (``_emit_prompt_completion``). The
attachment is a TYPED MARKER plus a header carrier: the full reply text rides in
its ``prompt_preview``, the guest renders the reply from that, and the
PromptCompletion row itself stays on the host — ``prompt_completion`` declares no
``main_subdir``, so the packer never ships it and the receiver never gets a row.

The receiver's body probe did not know that. ``_type_id_attachment_present`` looks
for a record folder or a staged entry, finds neither, and reported the reference
as missing — on EVERY reply, forever, however many times it was downloaded. That
is the "Downloaded + warning triangle" on a reply, with nothing to retry.

Real packer, real unpack, real serializer; the attachment dict comes from the
production ``_emit_prompt_completion``. Nothing is mocked or hand-forced.

# do not increase timeout without approval
"""

from __future__ import annotations

import shutil

import pytest

from flow_sdk.app.actions.execute_prompt import _emit_prompt_completion
from flow_sdk.builtin.flow_message import Attachment, FlowMessage
from flow_sdk.builtin.flow_message_bundle import pack_bundle, unpack_bundle
from flow_sdk.fs_store.record_paths import shadow_dir_for

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

FM_ID = "fa11fa11-0000-4000-8000-00000000c0a1"
REPLY = "The answer is 42."


async def test_a_received_reply_is_not_reported_missing(tmp_path):
    # Host side: the production code mints the entity and the reply attachment.
    att = await _emit_prompt_completion(
        REPLY,
        prompt_id=None,
        session_id="aaaaaaaa-0000-4000-8000-000000000001",
        host_process_id="bbbbbbbb-0000-4000-8000-000000000002",
        source_session_id=None,
    )
    fm = FlowMessage(text=f"Prompt response: {REPLY}", sender_name="Host", attachment=[Attachment(**att)])
    fm.id = FM_ID
    zip_path = await pack_bundle(fm, dest_dir=tmp_path)

    # Guest side: a clean receiver, which never gets the host's PromptCompletion row.
    # One machine plays both roles here, and ``delete()`` leaves the record FOLDER
    # behind — which the probe would then count as "present". Remove it as well, so
    # the receiver is what a real guest is: nothing of the host's entity on disk.
    from flow_sdk.builtin.prompt_completion import PromptCompletion

    ref_id = att["data"].partition("-")[2]
    row = await PromptCompletion.get_one({"id": ref_id})
    if row is not None:
        await row.delete()
    shutil.rmtree(shadow_dir_for("prompt_completion", ref_id), ignore_errors=True)
    await unpack_bundle(zip_path, local_user_id="receiver")

    received = await FlowMessage.get_one({"id": FM_ID})
    assert received is not None
    state = received.model_dump(mode="json")

    assert state["body_downloaded"] is True, "the bundle was pulled and unpacked"
    assert state["body_missing_attachments"] == [], (
        "a PromptCompletion reply is complete as received — its text rides in the header's "
        f"prompt_preview and the row is host-local by design — yet it was reported missing: "
        f"{state['body_missing_attachments']}"
    )
