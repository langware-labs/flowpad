"""Evicting a PTY session must release everyone waiting on it.

``PtyRegistry.close_session`` popped the session out of ``states`` and tore
down the OS child without putting the ``None`` close sentinel on the session's
queues. Anything blocked on ``q.get()`` then waited forever, because the
session was already gone and nothing would ever put to those queues again.

``wait_for_composer_ready`` is the consumer that makes this visible: its
contract is "returns False when the PTY closes", which quietly became "hangs".
A gated first prompt stalled instead of falling through to blind delivery.

Both queue lists matter — ``output()`` iterators read ``output_queues`` while
the composer gate registers on ``sequenced_output_queues`` — so a fix that
signals only one leaves half the waiters stuck.
"""

from __future__ import annotations

import asyncio

import pytest

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(5)

PTY_KEY = ("cn-1", "pn-1", "shell-1")


def _registry():
    from flow_sdk.compute.providers.desktop.pty_session_manager import PtyRegistry

    return PtyRegistry()


def _session(reg):
    """A PtyState parked in the registry with one waiter on each queue list."""
    from flow_sdk.compute.providers.desktop.pty_session_manager import PtyState

    session = PtyState(pty_key=PTY_KEY, shell_id=PTY_KEY[2])
    session.output_queues = []
    session.sequenced_output_queues = []
    session.pty_stream_file = None
    reg.states[PTY_KEY] = session
    return session


async def test_close_session_releases_waiters_on_both_queue_lists():
    reg = _registry()
    session = _session(reg)

    plain: asyncio.Queue = asyncio.Queue()
    sequenced: asyncio.Queue = asyncio.Queue()
    session.output_queues.append(plain)
    session.sequenced_output_queues.append(sequenced)

    waiters = [asyncio.create_task(plain.get()), asyncio.create_task(sequenced.get())]
    await asyncio.sleep(0)

    await reg.close_session(PTY_KEY)

    # Both must wake with the close sentinel rather than hang.
    done = await asyncio.wait_for(asyncio.gather(*waiters), timeout=2)
    assert done == [None, None], "close_session must put the None sentinel on BOTH queue lists"


async def test_close_session_on_unknown_key_is_a_noop():
    reg = _registry()
    await reg.close_session(("cn-x", "pn-x", "shell-x"))  # must not raise


async def test_close_session_with_no_waiters_is_a_noop():
    reg = _registry()
    _session(reg)
    await reg.close_session(PTY_KEY)
    assert PTY_KEY not in reg.states
