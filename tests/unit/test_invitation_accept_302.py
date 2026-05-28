"""Verify ``handle_invitation_accept`` rejects a 302 from the hub instead of
running local cleanup as if the accept had succeeded.

Probed against the production hub on 2026-05-28: ``GET /members/accept``
returns ``302 → /login.html?target_path=...`` for **both** missing and
invalid Authorization headers — never as a "post-accept landing." The
earlier ``if resp.status_code in (200, 302, 409): run_cleanup`` logic
silently marked invitations accepted locally for a hub that never
accepted them, leaving the recipient as a participant with no role and
a downstream cascade of 401 ("no valid access for role ['member']")
errors.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest


@pytest.mark.asyncio
async def test_handle_invitation_accept_302_returns_failure_and_skips_cleanup(monkeypatch):
    from flow_sdk.app.actions import flow_message_action
    from flow_sdk.responses.response import ApiFailResponse

    monkeypatch.setattr(flow_message_action, "hub_base_url", lambda: "https://hub.test", raising=False)
    # If any post-accept hub call runs on a 302 path, the cleanup is broken —
    # AssertionError-stub it so the test fails loudly.
    monkeypatch.setattr(
        flow_message_action,
        "hub_get",
        AsyncMock(side_effect=AssertionError("hub_get must not be called when accept returns 302")),
        raising=False,
    )

    location = (
        "https://hub.test/login.html?target_path="
        "https%3A%2F%2Fhub.test%2Fapi%2Fv1%2Fgraph%2Fmembers%2Faccept"
        "%3Finvitation-id%3Ddeadbeef-dead-beef-dead-beefdeadbeef"
    )
    mock_resp = MagicMock(spec=httpx.Response)
    mock_resp.status_code = 302
    mock_resp.headers = {"location": location}
    mock_resp.text = ""

    mock_client = MagicMock()
    mock_client.request = AsyncMock(return_value=mock_resp)
    mock_client.post = AsyncMock(side_effect=AssertionError("hub.post must not be called when accept returns 302"))
    mock_client.get = AsyncMock(side_effect=AssertionError("hub.get must not be called when accept returns 302"))
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch("flow_sdk.cloud_client.FlowpadClient", return_value=mock_client):
        result = await flow_message_action.handle_invitation_accept(
            {"invitation_id": "deadbeef-dead-beef-dead-beefdeadbeef"},
            someone_typeid="user-1",
        )

    assert isinstance(result, ApiFailResponse)
    assert "login" in result.message.lower() or "302" in result.message
    # The Location should be carried forward so the warning surface can show
    # where the redirect pointed (debugging aid).
    assert "login.html" in result.message
    mock_client.request.assert_awaited_once()
    mock_client.post.assert_not_called()
    mock_client.get.assert_not_called()


@pytest.mark.asyncio
async def test_handle_invitation_accept_non_2xx_non_302_returns_failure(monkeypatch):
    """Other non-success codes (e.g. 500) still surface as ApiFailResponse —
    the 302-specific message only fires for 302."""
    from flow_sdk.app.actions import flow_message_action
    from flow_sdk.responses.response import ApiFailResponse

    monkeypatch.setattr(flow_message_action, "hub_base_url", lambda: "https://hub.test", raising=False)

    mock_resp = MagicMock(spec=httpx.Response)
    mock_resp.status_code = 500
    mock_resp.headers = {}
    mock_resp.text = '{"detail": "boom"}'

    mock_client = MagicMock()
    mock_client.request = AsyncMock(return_value=mock_resp)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch("flow_sdk.cloud_client.FlowpadClient", return_value=mock_client):
        result = await flow_message_action.handle_invitation_accept(
            {"invitation_id": "deadbeef-dead-beef-dead-beefdeadbeef"},
            someone_typeid="user-1",
        )

    assert isinstance(result, ApiFailResponse)
    assert "500" in result.message
    assert "login" not in result.message.lower()
