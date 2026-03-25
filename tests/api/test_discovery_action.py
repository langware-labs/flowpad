"""
Test that the discovery/claude_session action returns 200 with null data
when a session UUID is not found on disk.

Background: When a Claude session just started, the session file may not exist
yet (race condition). The discovery endpoint must return 200/null (not 4xx/5xx)
so the browser doesn't log console errors during normal session startup.
"""

import pytest


@pytest.mark.asyncio
async def test_discovery_missing_uuid_returns_200_null(bootstrapped_client):
    """GET /discovery/claude_session?uuid=<nonexistent> must return 200 with null data.

    Session files may not exist yet during normal startup (race condition).
    A 4xx/5xx response causes a browser console error via Axios.
    """
    response = await bootstrapped_client.get(
        "/api/v1/graph/compute_node/@local/discovery/claude_session",
        params={"uuid": "nonexistent-session-uuid-12345"},
    )
    assert response.status_code == 200, (
        f"Expected 200 for missing session (not-found is normal during startup), "
        f"got {response.status_code}: {response.text}"
    )
    body = response.json()
    assert body.get("status") == "SUCCESS"
    assert body.get("data") is None
