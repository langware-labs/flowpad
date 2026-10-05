"""The Windows server loop keeps listening when a client hangs up mid-accept.

asyncio's Proactor closes the LISTENING socket on any accept OSError; on Windows a
peer that drops before the accept completes is ``WinError 64`` — one impatient
client took the backend offline (2026-10-06, QEMU Windows host). The loop itself
only exists on Windows (proven there by toggling it); this pins which accept
failures count as "the peer went away" — the only ones that re-arm.
"""

import sys

import pytest

from flow_sdk.server.win_loop import _peer_gone


def _winerr(code: int) -> OSError:
    exc = OSError(22, "win")
    exc.winerror = code
    return exc


@pytest.mark.parametrize("code", [64, 1236, 10053, 10054])
def test_a_client_that_went_away_is_peer_gone(code):
    assert _peer_gone(_winerr(code))


def test_resets_and_aborts_are_peer_gone():
    assert _peer_gone(ConnectionResetError())
    assert _peer_gone(ConnectionAbortedError())


@pytest.mark.parametrize("code", [995, 10038, 5, None])
def test_anything_else_still_closes_the_listener(code):
    # 995 = the operation was aborted (the socket is closing), 10038 = not a socket.
    exc = OSError(22, "win") if code is None else _winerr(code)
    assert not _peer_gone(exc)


@pytest.mark.skipif(sys.platform != "win32", reason="the Proactor loop exists on Windows only")
def test_the_server_runs_the_resilient_loop_on_windows():
    import asyncio

    from flow_sdk.server.win_loop import ResilientProactorEventLoop

    assert issubclass(ResilientProactorEventLoop, asyncio.ProactorEventLoop)
