"""The loopback callback listener must actually close when a flow ends.

Cancelling uvicorn's ``serve()`` task skips ``shutdown()``, so every finished,
timed-out or cancelled desktop OAuth flow left its port LISTENing for the life of
the backend (three stranded ports on one staging instance, 2026-09-15).
"""

from __future__ import annotations

import asyncio
import socket

import pytest

from flow_sdk.app.actions.desktop_oauth import DesktopOAuthSession

pytestmark = pytest.mark.asyncio


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


async def test_stopping_a_callback_server_closes_its_port():
    session = DesktopOAuthSession(
        state="s", code_verifier="v", redirect_uri="http://localhost/callback", user_id="u", provider="anthropic"
    )
    port = DesktopOAuthSession._find_free_port()
    session.callback_server = asyncio.create_task(session._start_callback_server(port, "s"))
    await _serving(port)

    await session.stop_callback_server()

    assert session.callback_server is None
    assert not _listening(port)


async def test_a_timed_out_wait_closes_its_port():
    session = DesktopOAuthSession(
        state="t", code_verifier="v", redirect_uri="http://localhost/callback", user_id="u", provider="anthropic"
    )
    port = DesktopOAuthSession._find_free_port()
    session.callback_server = asyncio.create_task(session._start_callback_server(port, "t"))
    await _serving(port)

    with pytest.raises(ValueError, match="timeout"):
        await session.wait_for_callback(timeout=0.05)

    assert not _listening(port)
