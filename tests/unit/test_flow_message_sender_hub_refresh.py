"""A hub refresh keeps the sender this machine typed.

The hub stores only `sender_id`, and its copy of an agent's reply names the person whose
login carried it. Taking that back would turn the agent's reply into the person's."""
from __future__ import annotations

from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.schema.data_spec.message_sender_spec import MessageSender


def _refreshed(local: FlowMessage, hub_sender_id: str) -> FlowMessage:
    payload = {**local.model_dump(mode="json"), "sender": None, "sender_id": hub_sender_id}
    return FlowMessage.model_validate(FlowMessage.merge_hub_payload(local, payload))


def test_an_agents_reply_stays_the_agents_after_a_hub_refresh():
    local = FlowMessage(text="t", sender=MessageSender.agent("a-1"), sender_id="agent:a-1")
    assert _refreshed(local, "cloud-user").sender == MessageSender.agent("a-1")


def test_a_person_follows_the_id_the_hub_stamped_after_login():
    local = FlowMessage(text="t", sender_id="me-local")
    assert _refreshed(local, "me-cloud").sender == MessageSender.user("me-cloud")
