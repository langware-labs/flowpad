"""Regression capture — Bug C: PTY output dropped in total silence.

``PtyActionsMixin._send_pty_output_to_client`` is the single seam between a
PTY's output pump and a client's WebSocket. Two proven silent-loss modes
(backend-restart RCA, this branch):

1. **Missing connection** — the pump broadcasts to an ``attached_connections``
   entry whose WS the server no longer holds (e.g. the client's socket died
   and it re-attached over HTTP with a connection_id that never re-dialed).
   ``get_connection_handler`` returns None and the function returns without
   logging ANYTHING — the user stares at a frozen pane while every log looks
   healthy.

2. **Invalid (non-UUID) connection id** — ``TypeId(...)`` raises ValueError
   BEFORE the try block; in production the exception is swallowed whole by
   ``asyncio.run_coroutine_threadsafe`` (nobody reads the future), so
   delivery for that subscriber dies invisibly.

The contract captured here: a drop must never raise out of the seam, and must
always leave a diagnostic line. Both tests fail today — (2) with the very
ValueError production swallows, (1) on the absent log line.
"""

import logging

import pytest

from flow_sdk.builtin.faas.pty_actions import PtyActionsMixin

pytestmark = pytest.mark.timeout(10)

SHELL_ID = "3b745aeb-1112-4edc-8415-49a77dc5a588"


async def test_drop_for_missing_connection_is_logged(caplog):
    """Output for a connection the server doesn't hold must log the drop."""
    with caplog.at_level(logging.DEBUG):
        await PtyActionsMixin._send_pty_output_to_client(
            "req-msg-id",
            "e2f5a1c4-9d3b-4f6a-8c7e-1a2b3c4d5e6f",  # valid UUID, not connected
            "provider-node",
            SHELL_ID,
            b"frozen pane bytes",
            7,
        )
    dropped = [r for r in caplog.records if "e2f5a1c4" in r.getMessage()]
    assert dropped, (
        "PTY output for an unknown connection was dropped with no log line — "
        "the frozen-pane failure mode is invisible in the backend log"
    )


async def test_invalid_connection_id_does_not_raise_and_is_logged(caplog):
    """A non-UUID connection_id must not blow up the output pump (in
    production the raise is swallowed by run_coroutine_threadsafe — losing
    the whole chunk fan-out for that subscriber, invisibly)."""
    with caplog.at_level(logging.DEBUG):
        await PtyActionsMixin._send_pty_output_to_client(
            "req-msg-id",
            "probe-notauuid",  # what a headless/REST client may register with
            "provider-node",
            SHELL_ID,
            b"frozen pane bytes",
            8,
        )
    dropped = [r for r in caplog.records if "probe-notauuid" in r.getMessage()]
    assert dropped, "PTY output for an invalid connection id was dropped with no log line"
