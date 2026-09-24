"""A terminal's first words are kept.

Output the PTY prints before its session is registered — a login shell's prompt, a command that
writes at once — used to be dropped: not counted, not in the stream file, sent to nobody. The
prompt was the only output a fresh shell makes, so its output counter stayed 0 and every typed
command (``Shell.write``) waited out the whole readiness budget. Found as a local deployment that
took 5 s to start, every time.
"""

import sys

import pytest

from flow_sdk.compute.providers.desktop.pty_session_manager import pty_registry

from tests.unit.conftest import kill_pty, make_shell, poll_read, tmp_records_root  # noqa: F401

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


@pytest.fixture(autouse=True)
def _use_tmp_records_root(tmp_records_root):
    return tmp_records_root


async def test_what_a_pty_prints_at_once_is_counted_and_kept():
    shell = make_shell(workdir="/tmp")
    await shell.start_pty(spawn_args=[sys.executable, "-c", "print('first words', flush=True); import time; time.sleep(5)"])
    try:
        await poll_read(shell, b"first words", timeout=5)
        await shell.ensure_live_compute_node_binding()
        state = pty_registry.states[(shell.compute_node_id, shell.compute_node.node_provider_id, shell.id)]
        assert state.seq > 0, "the first output is counted — what readiness reads"
    finally:
        await kill_pty(shell)
