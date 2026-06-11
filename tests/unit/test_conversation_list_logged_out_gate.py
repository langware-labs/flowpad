"""The conversation-list handler must not touch the hub when logged out.

Regression guard for the cloud-login gate added to
``handle_conversation_list``. While the instance has no cloud session, the
handler used to fire ``hub_get(CONVERSATION)`` + ``hub_get(INVITATION,
pending)`` unconditionally; the hub answered 401, which surfaced as a
"Cloud Request Failed" warning and fed the hub-error suppression window
("Hub errors suppressed" toast) on every idle inbox/home view.

The gate (``flow_sdk.cli.auth.hub_login.hub_auth_available``) short-circuits
to a local-only response with ``auth_required=True`` before the hub calls.
This test drives the REAL predicate via its two inputs (no api_key setting and
no file-based login → both OR branches resolve to "unauthenticated") and
asserts the handler returns the degraded shape and issues no hub call.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_conversation_list_skips_hub_when_logged_out(monkeypatch):
    from flow_sdk.app.actions import flow_message_action as fma

    # Hub is configured (so we pass the local-only ``not hub_base_url()``
    # early-return and actually reach the cloud-login gate under test).
    monkeypatch.setattr(fma, "hub_base_url", lambda: "http://hub.invalid")

    # Unauthenticated: no api_key instance setting AND no file-based login, so
    # the real ``hub_auth_available()`` returns False through both branches.
    monkeypatch.setattr("flow_sdk.cli.auth.hub_login.is_logged_in", lambda: False)
    monkeypatch.setattr(
        "flow_sdk.instance_settings.get_instance_settings",
        lambda: SimpleNamespace(cloud_api_key=None),
    )

    # Any hub call is a failure — the gate must short-circuit before the gather.
    async def _boom(*args, **kwargs):
        raise AssertionError("hub_get must not be called when logged out")

    monkeypatch.setattr(fma, "hub_get", _boom)

    # someone_typeid is unused on the gated path (no upsert/materialize runs).
    resp = await fma.handle_conversation_list("local-someone-typeid")

    data = resp.data
    assert data["auth_required"] is True
    assert data["hub_reachable"] is False
    assert "conversations" in data  # local list still returned for rendering
    assert data["bg_fetch_dispatched"] == []
