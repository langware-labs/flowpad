"""`add_message` multipart: an uploaded file lands on the message byte-for-byte, and a form
attachment sent beside it (multipart carries it as JSON text) still rides the message —
the shape `flow conversation send --file … --form …` posts."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.builtin.flow_message import AttachmentType, FlowMessage
from flow_sdk.schema.data_spec.message_form_spec import MessageForm, form_attachment, form_in
from flow_sdk.storage import get_entity_embedded_storage
from tests.api.test_add_message_prompt_entity import _make_conversation

pytestmark = pytest.mark.asyncio

BUNDLE = b"# v2 git bundle\n\x00\x01binary\xff"


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_file_and_form_ride_one_multipart_send(bootstrapped_client, user):
    client = bootstrapped_client
    conv_id = await _make_conversation(client)
    form = MessageForm.model_validate(
        {"form_id": "f1", "title": "ok?", "fields": [{"id": "a", "label": "A", "type": "yesno", "default": True}]}
    )

    resp = await client.post(
        f"/api/v1/graph/conversation/{conv_id}/add_message",
        data={"text": "her commits", "is_draft": "true", "attachment": json.dumps([form_attachment(form)])},
        files=[("files", ("shani.bundle", BUNDLE, "application/octet-stream"))],
    )
    assert resp.json().get("status") == "SUCCESS", resp.text
    fm = await FlowMessage.get_one({"id": resp.json()["data"]["flow_message_id"]})

    files = [a for a in fm.attachment or [] if a.attachment_type == AttachmentType.FILE]
    assert [a.data.rsplit("/", 1)[-1] for a in files] == ["shani.bundle"]
    on_disk = Path(get_entity_embedded_storage(fm.typeid).get_storage_path(files[0].data))
    assert on_disk.read_bytes() == BUNDLE
    assert form_in(fm.attachment).form_id == "f1"
