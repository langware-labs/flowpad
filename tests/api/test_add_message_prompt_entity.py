"""API tests for entity-backed conversation prompts: `add_message` with
``prompt_text`` mints a library Prompt entity and attaches it as TYPE_ID
(carrying ``proposer_id`` + ``prompt_preview``); re-sends dedup by normalized
text; ``approve-prompt`` flips ``approved_by`` on entity-prompt attachments
(and still on legacy PROMPT ones). Sends use ``is_draft`` — the local-only
path that skips the cloud-login gate while still exercising ``_attach_prompt``.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.builtin.flow_message import AttachmentType, FlowMessage
from flow_sdk.builtin.prompt import Prompt

pytestmark = pytest.mark.asyncio

PROMPT_TEXT = "Fix the auth flow\nand add regression tests."

# A tiny but real PNG header — carries NUL bytes, so it is unambiguously binary
# and would turn into garbage if decoded as UTF-8 text.
PNG_BYTES = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x02\x00\x00\x00\x90wS\xde"
)


async def _local_project_id(client) -> str:
    projects = (await client.get("/api/v1/graph/project")).json()["data"]
    return next(p for p in projects if p.get("uname") == "local")["id"]


async def _make_conversation(client) -> str:
    project_id = await _local_project_id(client)
    resp = await client.post(
        "/api/v1/graph/conversation-create",
        json={"project_id": project_id, "participants": []},
    )
    assert resp.json().get("status") == "SUCCESS", resp.text
    return resp.json()["data"]["conversation_id"]


def _prompt_entity_attachments(fm: FlowMessage) -> list:
    return [
        a for a in (fm.attachment or [])
        if a.attachment_type == AttachmentType.TYPE_ID and (a.data or "").split("-", 1)[0] == "prompt"
    ]


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_send_prompt_creates_entity_attachment(bootstrapped_client, user):
    client = bootstrapped_client
    conv_id = await _make_conversation(client)

    resp = await client.post(
        f"/api/v1/graph/conversation/{conv_id}/add_message",
        json={"message": "please run this", "prompt_text": PROMPT_TEXT, "is_draft": True},
    )
    assert resp.json().get("status") == "SUCCESS", resp.text
    fm_id = resp.json()["data"]["flow_message_id"]

    fm = await FlowMessage.get_one({"id": fm_id})
    atts = _prompt_entity_attachments(fm)
    assert len(atts) == 1
    att = atts[0]
    assert att.prompt_preview == PROMPT_TEXT
    assert att.proposer_id  # stamped from the sender
    assert not att.approved_by

    prompt_id = att.data.split("-", 1)[1]
    prompt = await Prompt.get_by_id(prompt_id)
    assert prompt is not None
    assert prompt.text == PROMPT_TEXT
    assert prompt.name == "Fix the auth flow"  # auto-name = first line
    assert (prompt.use_count or 0) == 0  # sending is not a "use"


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_image_prompt_file_stays_a_picture_not_text(bootstrapped_client, user):
    """An image attached to a prompt is stored as a prompt-FILE (raw bytes the
    UI renders inline), never decoded into a garbage text Prompt entity. The
    typed text still mints its own Prompt — text stays text, image stays image.
    """
    client = bootstrapped_client
    conv_id = await _make_conversation(client)

    resp = await client.post(
        f"/api/v1/graph/conversation/{conv_id}/add_message",
        data={"message": "look at this", "prompt_text": "describe the screenshot", "is_draft": "true"},
        files=[("prompt_files", ("shot.png", PNG_BYTES, "image/png"))],
    )
    assert resp.json().get("status") == "SUCCESS", resp.text
    fm_id = resp.json()["data"]["flow_message_id"]
    fm = await FlowMessage.get_one({"id": fm_id})

    # The image is a prompt-FILE attachment (raw bytes), not a text Prompt entity.
    prompt_files = [
        a for a in (fm.attachment or [])
        if a.attachment_type == AttachmentType.PROMPT and (a.data or "").startswith("prompt/")
    ]
    assert len(prompt_files) == 1
    assert prompt_files[0].data == "prompt/shot.png"
    assert prompt_files[0].proposer_id  # rides the same approval lifecycle

    # Bytes were written verbatim to the FlowMessage VFS so the UI streams a picture.
    from flow_sdk.storage import get_entity_embedded_storage
    storage = get_entity_embedded_storage(fm.typeid)
    on_disk = Path(storage.get_storage_path("prompt/shot.png"))
    assert on_disk.exists()
    assert on_disk.read_bytes() == PNG_BYTES

    # The typed text still mints exactly one Prompt entity — and the binary image
    # never leaked into any prompt's text.
    entity_atts = _prompt_entity_attachments(fm)
    assert len(entity_atts) == 1
    assert entity_atts[0].prompt_preview == "describe the screenshot"
    prompt = await Prompt.get_by_id(entity_atts[0].data.split("-", 1)[1])
    assert prompt is not None
    assert "PNG" not in (prompt.text or "")


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_image_only_prompt_mints_no_text_entity(bootstrapped_client, user):
    """An image with no typed text produces a prompt-file attachment and zero
    text Prompt entities — nothing to decode into binary."""
    client = bootstrapped_client
    conv_id = await _make_conversation(client)

    resp = await client.post(
        f"/api/v1/graph/conversation/{conv_id}/add_message",
        data={"message": "", "is_draft": "true"},
        files=[("prompt_files", ("diagram.png", PNG_BYTES, "image/png"))],
    )
    assert resp.json().get("status") == "SUCCESS", resp.text
    fm = await FlowMessage.get_one({"id": resp.json()["data"]["flow_message_id"]})

    prompt_files = [
        a for a in (fm.attachment or [])
        if a.attachment_type == AttachmentType.PROMPT and (a.data or "").startswith("prompt/")
    ]
    assert len(prompt_files) == 1
    assert _prompt_entity_attachments(fm) == []


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_resend_same_text_dedups_to_one_prompt(bootstrapped_client, user):
    client = bootstrapped_client
    conv_id = await _make_conversation(client)

    first = await client.post(
        f"/api/v1/graph/conversation/{conv_id}/add_message",
        json={"message": "run A", "prompt_text": "dedup   me\nplease", "is_draft": True},
    )
    second = await client.post(
        f"/api/v1/graph/conversation/{conv_id}/add_message",
        json={"message": "run B", "prompt_text": "dedup me please", "is_draft": True},
    )
    fm1 = await FlowMessage.get_one({"id": first.json()["data"]["flow_message_id"]})
    fm2 = await FlowMessage.get_one({"id": second.json()["data"]["flow_message_id"]})
    [att1] = _prompt_entity_attachments(fm1)
    [att2] = _prompt_entity_attachments(fm2)
    assert att1.data == att2.data  # same Prompt entity, whitespace-normalized match


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_approve_prompt_flips_entity_attachment(bootstrapped_client, user):
    client = bootstrapped_client
    conv_id = await _make_conversation(client)

    resp = await client.post(
        f"/api/v1/graph/conversation/{conv_id}/add_message",
        json={"message": "", "prompt_text": "approve me", "is_draft": True},
    )
    fm_id = resp.json()["data"]["flow_message_id"]

    approve = await client.post(
        f"/api/v1/graph/flow_message/{fm_id}/approve-prompt",
        json={"approve_all": True},
    )
    assert approve.json().get("status") == "SUCCESS", approve.text
    assert approve.json()["data"]["attachment_indices"]

    fm = await FlowMessage.get_one({"id": fm_id})
    [att] = _prompt_entity_attachments(fm)
    assert att.approved_by


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_approve_prompt_still_flips_legacy_prompt(bootstrapped_client, user):
    """Backward compat: a pre-existing message with AttachmentType.PROMPT
    still approves through the generalized predicate."""
    from flow_sdk.builtin.flow_message import Attachment

    client = bootstrapped_client
    conv_id = await _make_conversation(client)
    resp = await client.post(
        f"/api/v1/graph/conversation/{conv_id}/add_message",
        json={"message": "legacy carrier", "is_draft": True},
    )
    fm_id = resp.json()["data"]["flow_message_id"]

    # Retrofit a legacy PROMPT attachment (what an old sender would have written).
    fm = await FlowMessage.get_one({"id": fm_id})
    fm.attachment = [
        *(fm.attachment or []),
        Attachment(attachment_type=AttachmentType.PROMPT, data="legacy inline prompt", proposer_id="someone"),
    ]
    await fm.save()

    approve = await client.post(
        f"/api/v1/graph/flow_message/{fm_id}/approve-prompt",
        json={"approve_all": True},
    )
    assert approve.json().get("status") == "SUCCESS", approve.text

    fm = await FlowMessage.get_one({"id": fm_id})
    legacy = [a for a in fm.attachment if a.attachment_type == AttachmentType.PROMPT]
    assert legacy and legacy[0].approved_by


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_send_with_session_id_stamps_field_and_carrier(bootstrapped_client, user):
    """[LIVE-SESSION] ``add_message`` with ``remote_worker_session_id`` stamps
    the FlowMessage header field AND auto-appends the authoritative
    ``remote_worker_session-<id>`` TYPE_ID carrier attachment (the hub drops
    the header field until its schema mirrors it)."""
    client = bootstrapped_client
    conv_id = await _make_conversation(client)
    session_id = "a1a1a1a1-0000-4000-8000-0000000000f1"

    resp = await client.post(
        f"/api/v1/graph/conversation/{conv_id}/add_message",
        json={
            "message": "run this in my live session",
            "prompt_text": PROMPT_TEXT,
            "is_draft": True,
            "remote_worker_session_id": session_id,
        },
    )
    assert resp.json().get("status") == "SUCCESS", resp.text
    fm_id = resp.json()["data"]["flow_message_id"]

    fm = await FlowMessage.get_one({"id": fm_id})
    assert fm.remote_worker_session_id == session_id
    carriers = [
        a for a in (fm.attachment or [])
        if a.attachment_type == AttachmentType.TYPE_ID
        and a.data == f"remote_worker_session-{session_id}"
    ]
    assert len(carriers) == 1
    # kind is only settable to session_event explicitly; a plain send stays USER.
    assert fm.kind == "user"


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_session_event_kind_honored_and_others_rejected(bootstrapped_client, user):
    """[LIVE-SESSION] ``kind=session_event`` is honored; any other kind value
    (e.g. the local-only ``invitation``) is ignored and stays USER."""
    client = bootstrapped_client
    conv_id = await _make_conversation(client)
    session_id = "a1a1a1a1-0000-4000-8000-0000000000f2"

    resp = await client.post(
        f"/api/v1/graph/conversation/{conv_id}/add_message",
        json={
            "message": "Alice approved the live session",
            "is_draft": True,
            "remote_worker_session_id": session_id,
            "kind": "session_event",
        },
    )
    assert resp.json().get("status") == "SUCCESS", resp.text
    fm = await FlowMessage.get_one({"id": resp.json()["data"]["flow_message_id"]})
    assert fm.kind == "session_event"
    assert fm.remote_worker_session_id == session_id

    resp = await client.post(
        f"/api/v1/graph/conversation/{conv_id}/add_message",
        json={"message": "sneaky", "is_draft": True, "kind": "invitation"},
    )
    assert resp.json().get("status") == "SUCCESS", resp.text
    fm2 = await FlowMessage.get_one({"id": resp.json()["data"]["flow_message_id"]})
    assert fm2.kind == "user"
