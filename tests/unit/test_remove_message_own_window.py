"""A sender deletes their own message for 15 minutes; the conversation owner, any time."""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from flow_sdk.app.actions import flow_message_action as fma

CLOUD_ME, LOCAL_ME, OTHER = "cloud-me", "local-me", "someone-else"


def _message(sender_id: str, minutes_old: float) -> SimpleNamespace:
    sent = datetime.now(timezone.utc) - timedelta(minutes=minutes_old)
    return SimpleNamespace(id="fm-1", sender_id=sender_id, conversation_id="conv-1", occurred_at=sent)


@pytest.fixture
def gate(monkeypatch):
    """``handle_remove_message`` up to the hub call: answers ``"hub"`` when the gate lets it through."""

    async def run(fm, *, owner: str = OTHER):
        async def remove_message(_fm_id):
            raise fma.HubError(599, "reached the hub")

        conv = SimpleNamespace(remote=True, initiated_by=owner, members=[], remove_message=remove_message)

        async def one(value):
            return value

        monkeypatch.setattr(fma.FlowMessage, "get_one", classmethod(lambda cls, _q: one(fm)))
        monkeypatch.setattr(fma.Conversation, "get_one", classmethod(lambda cls, _q: one(conv)))
        monkeypatch.setattr(fma.User, "self_ids", classmethod(lambda cls: one({CLOUD_ME, LOCAL_ME})))
        monkeypatch.setattr(fma, "_current_cloud_user_id", lambda: one(CLOUD_ME))
        monkeypatch.setattr(fma, "hub_base_url", lambda: "http://hub")
        response = await fma.handle_remove_message(fm.id)
        return "hub" if (response.data or {}).get("hub_status") == 599 else response.status_code

    return run


@pytest.mark.parametrize(
    "sender, minutes_old, owner, expected",
    [
        (CLOUD_ME, 1, OTHER, "hub"),
        (LOCAL_ME, 14, OTHER, "hub"),  # our own reply on a channel names the local user
        (CLOUD_ME, 16, OTHER, 403),
        (OTHER, 1, OTHER, 403),
        (OTHER, 600, CLOUD_ME, "hub"),  # the owner is not bound by the window
    ],
)
async def test_who_may_delete_and_for_how_long(gate, sender, minutes_old, owner, expected):
    assert await gate(_message(sender, minutes_old), owner=owner) == expected
