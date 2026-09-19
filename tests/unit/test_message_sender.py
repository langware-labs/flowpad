"""`MessageSender` is the ONLY home of the `sender_id` string grammar."""
from __future__ import annotations

import pytest

from flow_sdk.schema.data_spec.message_sender_spec import MessageSender, SenderKind


@pytest.mark.parametrize(
    "wire, expected",
    [
        ("9f0b1c2d-3e4f-4a5b-8c7d-6e5f4a3b2c1d", MessageSender.user("9f0b1c2d-3e4f-4a5b-8c7d-6e5f4a3b2c1d")),
        ("agent:a-1", MessageSender.agent("a-1")),
        ("gmail:a@b.test", MessageSender.external("gmail", "a@b.test")),
        ("gmail:unknown", MessageSender.external("gmail")),
        ("", None),
        (None, None),
    ],
)
def test_a_wire_id_names_one_typed_sender_and_travels_back_unchanged(wire, expected):
    sender = MessageSender.from_wire(wire)
    assert sender == expected
    if sender is not None:
        assert sender.wire_id == wire


def test_ours_is_one_of_our_user_ids_or_any_agent_never_a_stranger():
    mine = {"me-local", "me-cloud"}
    assert MessageSender.user("me-cloud").authored_by(mine)
    assert not MessageSender.user("someone").authored_by(mine)
    assert MessageSender.agent("a-1").authored_by(set())
    assert not MessageSender(kind=SenderKind.EXTERNAL, channel="gmail", address="me-local").authored_by(mine)
