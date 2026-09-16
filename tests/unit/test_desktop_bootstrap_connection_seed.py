"""The desktop bootstrap seeds the hub connection slot beside the login block.

Without it the client had nothing to seed the slot from, so a fresh load of a
signed-in instance painted the FlowPad account "Not connected" while
``/cloud/status`` said ``connected`` (staging, 2026-09-15).
"""

from __future__ import annotations


def test_bootstrap_carries_the_same_connection_block_as_cloud_status(monkeypatch):
    import flow_sdk.cloud_client.auth_state as auth_state
    from flow_sdk.cloud_client.ws_client import hub_ws_manager
    from flow_sdk.server.routes.bootstrap import get_desktop_bootstrap_info

    monkeypatch.setattr(auth_state, "login_block", lambda: {"status": "logged_in", "user": None, "reason": None})
    monkeypatch.setattr(hub_ws_manager, "connection_payload", lambda: {"status": "connected", "error": None})

    info = get_desktop_bootstrap_info()

    assert info.connection == {"status": "connected", "error": None}
    assert info.model_dump(mode="json")["connection"] == {"status": "connected", "error": None}
