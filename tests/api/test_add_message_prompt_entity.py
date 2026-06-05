"""API tests for entity-backed conversation prompts: `add_message` with
``prompt_text`` mints a library Prompt entity and attaches it as TYPE_ID
(carrying ``proposer_id`` + ``prompt_preview``); re-sends dedup by normalized
text; ``approve-prompt`` flips ``approved_by`` on entity-prompt attachments
(and still on legacy PROMPT ones). Sends use ``is_draft`` — the local-only
path that skips the cloud-login gate while still exercising ``_attach_prompt``.
"""
from __future__ import annotations

import pytest

from flow_sdk.builtin.flow_message import AttachmentType, FlowMessage
from flow_sdk.builtin.prompt import Prompt

pytestmark = pytest.mark.asyncio

PROMPT_TEXT = "Fix the auth flow\nand add regression tests."


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
