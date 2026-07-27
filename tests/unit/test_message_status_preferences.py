"""Tests for the per-installation message-status sharing preference."""

from __future__ import annotations

import pytest

from flow_sdk.cloud_client.hub_bridge import HubWsBridge
from flow_sdk.fs_store.identifier import mint_uuid


@pytest.mark.parametrize(("stored_value", "expected"), [(False, False), (True, True)])
def test_message_status_sharing_reads_boolean_preference(monkeypatch, stored_value, expected):
    import flow_sdk.preferences as preferences

    monkeypatch.setattr(preferences, "read_instance_pref", lambda key, default: stored_value)

    assert preferences.message_status_sharing_enabled() is expected


def test_message_status_sharing_defaults_on(monkeypatch):
    import flow_sdk.preferences as preferences

    monkeypatch.setattr(preferences, "read_instance_pref", lambda key, default: default)

    assert preferences.message_status_sharing_enabled() is True


@pytest.mark.asyncio
async def test_read_ack_is_skipped_when_sharing_is_disabled(monkeypatch):
    import flow_sdk.cloud_client.hub_bridge as hub_bridge

    class UnexpectedManager:
        async def send_request(self, *args, **kwargs):
            raise AssertionError("disabled sharing must not contact the hub")

    monkeypatch.setattr(hub_bridge, "message_status_sharing_enabled", lambda: False)
    message_ids = [mint_uuid(), mint_uuid()]

    result = await HubWsBridge(UnexpectedManager()).mark_received(flow_message_ids=message_ids)

    assert result == {
        "data": {
            "updated": [],
            "skipped": [
                {"id": message_ids[0], "reason": "message_status_sharing_disabled"},
                {"id": message_ids[1], "reason": "message_status_sharing_disabled"},
            ],
        }
    }
