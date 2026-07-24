"""Tests for the per-installation message-status sharing preference."""

from __future__ import annotations

import pytest

from flow_sdk.responses.response import ApiSuccessResponse


@pytest.mark.parametrize(
    ("stored_value", "expected"),
    [
        (False, False),
        (True, True),
        (None, True),
        ("false", True),
    ],
)
def test_message_status_sharing_only_explicit_false_disables(
    monkeypatch,
    stored_value,
    expected,
):
    import flow_sdk.preferences as preferences

    monkeypatch.setattr(
        preferences,
        "read_instance_pref",
        lambda key, default: stored_value,
    )

    assert preferences.message_status_sharing_enabled() is expected


@pytest.mark.parametrize(
    ("enabled", "local_user_id", "sender_id", "expected"),
    [
        (True, "local", "remote", True),
        (False, "local", "remote", False),
        (True, None, "remote", False),
        (True, "local", None, False),
        (True, "local", "local", False),
    ],
)
def test_delivery_ack_respects_preference_and_sender(
    monkeypatch,
    enabled,
    local_user_id,
    sender_id,
    expected,
):
    import flow_sdk.cloud_client.hub_bridge as hub_bridge
    import flow_sdk.preferences as preferences

    monkeypatch.setattr(
        preferences,
        "message_status_sharing_enabled",
        lambda: enabled,
    )

    assert hub_bridge._should_report_delivery(local_user_id, sender_id) is expected


@pytest.mark.asyncio
async def test_read_ack_is_skipped_when_sharing_is_disabled(monkeypatch):
    import flow_sdk.app.actions.flow_message_action as flow_message_action
    import flow_sdk.preferences as preferences

    class FakeRequestInfo:
        async def get_post_data(self):
            return {"flow_message_ids": ["flow-message-1", "flow-message-2"]}

    monkeypatch.setattr(
        flow_message_action,
        "get_current_request_info",
        lambda: FakeRequestInfo(),
    )
    monkeypatch.setattr(
        preferences,
        "message_status_sharing_enabled",
        lambda: False,
    )

    response = await flow_message_action.mark_received_action()

    assert isinstance(response, ApiSuccessResponse)
    assert response.data == {
        "updated": [],
        "skipped": [
            {
                "id": "flow-message-1",
                "reason": "message_status_sharing_disabled",
            },
            {
                "id": "flow-message-2",
                "reason": "message_status_sharing_disabled",
            },
        ],
    }
