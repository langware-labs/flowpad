"""A form's answers are an ordinary reply: ``handle_add_message`` checks them against their form."""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.app.actions.notification_action import handle_add_message
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse
from flow_sdk.fs_store.record_paths import (
    get_default_records_data_root,
    get_default_records_root,
    set_default_records_data_root,
    set_default_records_root,
)
from flow_sdk.schema.data_spec.message_form_spec import FormAnswers, MessageForm, answers_attachment, form_attachment

FORM = MessageForm(
    form_id="f1",
    title="Tell me",
    fields=[{"id": "role", "label": "Your role", "type": "one", "options": ["Dev", "Founder"]}],
)


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


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_answers_ride_add_message_and_must_fit_the_form(records_root):
    conv_id = str(uuid.uuid4())
    await Conversation.model_validate({"id": conv_id, "remote": False}).save(None)
    me = f"user-{uuid.uuid4()}"
    sent = await handle_add_message({"conversation_id": conv_id, "message": "q", "attachment": [form_attachment(FORM)]}, me)
    assert isinstance(sent, ApiSuccessResponse)

    def answer(values):
        att = answers_attachment(FormAnswers(form_id="f1", values=values))
        return handle_add_message({"conversation_id": conv_id, "message": "", "attachment": [att]}, me)

    assert isinstance(await answer({"role": "Founder"}), ApiSuccessResponse)
    bad = await answer({"role": "CEO"})
    assert isinstance(bad, ApiFailResponse) and bad.status_code == 400 and bad.data["problems"] == ["Your role: must be one of ['Dev', 'Founder']"]
