"""A group conversation is continued at the GROUP: its address is the room the driver names (``room_of``), never
the member who wrote — and a group source admits everyone in it (``open_inbound_for``), while the number's own
source keeps its allowlist. Generic machinery asked through the driver's declarations; WhatsApp is the driver that
makes them."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from flow_sdk.builtin.agent_serve import admits, answers_here
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


@pytest.mark.parametrize("status,allowed", [
    (SourceStatus.ACTIVE.value, ["10000000000"]),
    (SourceStatus.DISABLED.value, []),
])
def test_a_group_source_respects_restrictions(status, allowed):
    source = _source({"phone_number_id": "123", "group": GROUP}, allowed)
    source.status = status
    assert not admits(source, "972500000001")


@pytest.mark.parametrize("answer_place,placement,expected", [
    (None, "place-a", True),
    (None, "place-b", True),
    ("place-a", "place-a", True),
    ("place-a", "place-b", False),
])
async def test_a_group_source_answers_at_the_selected_placement(answer_place, placement, expected):
    source = _source({"phone_number_id": "123", "group": GROUP})
    source.answer_place = answer_place
    assert await answers_here(source, SimpleNamespace(id=placement)) is expected
