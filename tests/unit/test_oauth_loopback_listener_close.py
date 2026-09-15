"""The loopback listener forwards to the one completion, and always closes.

Cancelling uvicorn's ``serve()`` task skips ``shutdown()``, so every finished,
timed-out or cancelled desktop OAuth flow left its port LISTENing for the life of
the backend (three stranded ports on one staging instance, 2026-09-15). The
listener now only forwards the provider's redirect to ``/auth/oauth/callback``,
where the flow registry finishes the grant once and tells its initiator.
"""

from __future__ import annotations

import asyncio
import socket

import httpx
import pytest

from flow_sdk.app.actions import desktop_oauth
from flow_sdk.app.actions.desktop_oauth import DesktopOAuthSession
from flow_sdk.core.oauth import flows
from flow_sdk.core.oauth.flows import AuthFlowKind, AuthFlowStatus
from flow_sdk.responses.response import ApiSuccessResponse
from tests.utils.oauth_flow_doubles import connect_tab, reset_flow_registry

pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    monkeypatch.setattr(desktop_oauth, "_desktop_oauth_sessions", {})
    return reset_flow_registry(monkeypatch)


def _listening(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.2)
        return probe.connect_ex(("127.0.0.1", port)) == 0


async def _serving(port: int) -> None:
    for _ in range(100):
        if _listening(port):
            return
        await asyncio.sleep(0.02)
    raise AssertionError("callback server never started listening")


async def _started(state: str) -> tuple[DesktopOAuthSession, int]:
    session = DesktopOAuthSession(
        state=state, code_verifier="v", redirect_uri="http://localhost/callback", user_id="u", provider="anthropic"
    )
    port = DesktopOAuthSession._find_free_port()
    session.callback_server = asyncio.create_task(session._start_callback_server(port))
    desktop_oauth._desktop_oauth_sessions[state] = session
    await _serving(port)
    return session, port


async def test_stopping_a_callback_server_closes_its_port():
    session, port = await _started("s")

    await session.stop_callback_server()

    assert session.callback_server is None
    assert not _listening(port)


async def test_the_listener_forwards_to_the_one_completion_and_closes():
    session, port = await _started("fwd")

    async with httpx.AsyncClient() as client:
        response = await client.get(f"http://127.0.0.1:{port}/callback?code=c1&state=fwd")
    await asyncio.wait_for(asyncio.shield(session.callback_server), timeout=5)

    assert response.status_code == 302
    assert response.headers["location"].endswith("/auth/oauth/callback?code=c1&state=fwd")
    assert not _listening(port)


async def test_a_timed_out_wait_closes_its_port_and_ends_the_flow():
    _session, port = await _started("t")
    flows.start_flow(AuthFlowKind.LOOPBACK, "anthropic", flow_id="t")

    response = await desktop_oauth.wait_for_desktop_oauth_callback("t", timeout=0.05)

    assert response.message == "OAuth callback timeout"
    assert not _listening(port)
    assert flows.get_flow("t").result.code == "timeout"


async def test_racing_landings_exchange_once_and_tell_only_the_initiator(isolated, monkeypatch):
    initiator = connect_tab(isolated, "tab-a")
    await _started("race")
    flows.start_flow(AuthFlowKind.LOOPBACK, "anthropic", flow_id="race", initiator_connection_id="tab-a")
    exchanges = []

    async def exchange(code, state):
        exchanges.append(code)
        return ApiSuccessResponse(message="ok")

    monkeypatch.setattr(desktop_oauth, "handle_desktop_oauth_callback", exchange)

    results = await asyncio.gather(*(desktop_oauth.complete_loopback_flow("race", "c1") for _ in range(3)))

    assert exchanges == ["c1"]
    assert {result.status for result, _ in results} == {AuthFlowStatus.SUCCESS}
    assert [message["status"] for message in initiator.sent] == ["success"]
