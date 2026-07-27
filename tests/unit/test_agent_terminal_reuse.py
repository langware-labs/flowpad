"""`flow terminal open` is idempotent — the agent must not litter the workspace.

An agent told "run it in the terminal" three times must drive ONE terminal, not
stack up three. The process remembers the terminal it opened in
``context_data[terminal_shell_id]``; ``_current_terminal`` is the decision that
makes ``open`` a re-show and lets ``run`` work with no ``--shell``.

Its safety-critical direction is refusing to hand back a corpse: the Shell row
outlives its PTY (backend restart, user closed the tab), and reusing a dead one
would write commands into nothing. Real entities, no mocks. The live-reuse
direction needs a real PTY and is covered in the browser walk.
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.agentic_process import TERMINAL_SHELL_KEY
from flow_sdk.builtin.shell import Shell

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


async def _process() -> AgenticProcess:
    proc = AgenticProcess(name=f"term-{uuid.uuid4().hex[:8]}")
    await proc.save()
    return proc


@pytest.mark.asyncio
async def test_no_terminal_remembered_yet() -> None:
    proc = await _process()
    assert await proc._current_terminal() is None


@pytest.mark.asyncio
async def test_a_remembered_but_deleted_shell_is_not_reused() -> None:
    proc = await _process()
    proc.context_data = {TERMINAL_SHELL_KEY: str(uuid.uuid4())}
    await proc.save()

    assert await proc._current_terminal() is None, "a vanished row must not be reused"


@pytest.mark.asyncio
async def test_a_remembered_shell_with_a_dead_pty_is_not_reused() -> None:
    # The row survives a backend restart; the PTY does not. Writing into this
    # shell would go nowhere, so `open` must mint a fresh one instead.
    shell = Shell(name="stale terminal", workdir="/tmp")
    await shell.save()
    assert not shell.is_alive, "fixture guard: a saved shell has no PTY yet"

    proc = await _process()
    proc.context_data = {TERMINAL_SHELL_KEY: str(shell.id)}
    await proc.save()

    assert await proc._current_terminal() is None


@pytest.mark.asyncio
async def test_the_remembered_key_is_not_the_process_transport_shell() -> None:
    # `agentic_process_id` marks the process's OWN transport shell and is driven
    # by the worker lifecycle — reusing it for a user terminal would tear the
    # user's terminal down whenever the worker restarted.
    assert TERMINAL_SHELL_KEY == "terminal_shell_id"
    assert TERMINAL_SHELL_KEY != "shell_id"
