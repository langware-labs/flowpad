"""A group conversation is continued at the GROUP: its address is the room the driver names (``room_of``), never
the member who wrote — and a group source admits everyone in it (``open_inbound_for``), while the number's own
source keeps its allowlist. Generic machinery asked through the driver's declarations; WhatsApp is the driver that
makes them."""
from __future__ import annotations

from types import SimpleNamespace

from flow_sdk.builtin.agent_serve import admits
from flow_sdk.builtin.data_source import SourceStatus
from flow_sdk.stream_inbox.projection import stamp_conversation

GROUP = "Y2FwaV9ncm91cDoxMjM0NTY3ODkwMTIzNDU6MTIwMzYzMDAwMDAwMDAwMDAx"


def _item(namespace: str, author: str):
    return SimpleNamespace(provider="whatsapp", origin_namespace=namespace, author_external_id=author,
                           occurred_at=None, recipients=[])


def test_a_group_message_addresses_the_group_not_its_writer():
    conversation = SimpleNamespace(started_at=None, address=[])
    assert stamp_conversation(conversation, _item(f"123/groups/{GROUP}", "972500000001"), ours=False)
    stamp_conversation(conversation, _item(f"123/groups/{GROUP}", "972500000002"), ours=False)
    assert conversation.address == [GROUP]


def test_a_one_to_one_message_still_addresses_its_writer():
    conversation = SimpleNamespace(started_at=None, address=[])
    stamp_conversation(conversation, _item("123/messages/972500000001", "972500000001"), ours=False)
    assert conversation.address == ["972500000001"]


def _source(config, allowed=()):
    return SimpleNamespace(status=SourceStatus.ACTIVE.value, provider="whatsapp", config=config,
                           allowed_senders=list(allowed))


def test_a_group_source_admits_everyone_in_it_and_the_number_keeps_its_allowlist():
    group = _source({"phone_number_id": "123", "group": GROUP})
    number = _source({"phone_number_id": "123"}, allowed=["972500000009"])
    assert admits(group, "972500000001") and admits(group, "972500000002")
    assert not admits(number, "972500000001") and admits(number, "972500000009")
    assert not admits(_source({"phone_number_id": "123"}), "972500000001"), "an empty list on the number: nobody"
