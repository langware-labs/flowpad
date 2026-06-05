"""Reproduces the leaked bracketed paste markers bug.

shell.write() injects \x1b[200~{cmd}\x1b[201~\r immediately after
shell.start() spawns the PTY subprocess. zsh hasn't initialised readline
yet, so the PTY kernel echoes the raw bytes back — '200~' and '201~'
appear literally in the output stream.

FAILS while bug is present. PASSES once the fix lands.
"""

import asyncio
import pytest

from tests.test_settings import test_service_config

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.faas.compute_node import ComputeNode


def _read_pty_stream(shell_id: str) -> str:
    """Cumulative PTY output from the on-disk .pty stream file (written on
    every output chunk from session start — replaces the old replay buffer
    as the test's capture source)."""
    from flow_sdk.builtin.shell import get_shell_record, shell_pty_stream_path

    record = get_shell_record(shell_id)
    if not record:
        return ""
    pty_pid = record.__dict__.get("pty_pid")
    if not pty_pid:
        return ""
    path = shell_pty_stream_path(record.id, pty_pid)
    if not path.exists():
        return ""
    return path.read_bytes().decode("utf-8", errors="replace")


@pytest.mark.asyncio
# do not increase timeout without approval
@pytest.mark.timeout(30)
async def test_clean_claude_pty(bootstrapped_client, tmp_path):
    """PTY output on AgenticProcess.start() must not contain leaked paste markers."""
    cn = await ComputeNode.get_one({"uname": "local"})
    assert cn, "No @local compute node found"

    process = AgenticProcess(
        compute_node_id=f"compute_node-{cn.id}",
        cli_config={"permission_mode": "bypassPermissions"},
        workdir=str(tmp_path),
        visible=True,
    )
    await process.save([])

    try:
        await process.start_pty()

        shell_id = process.shell_id
        assert shell_id, "process.start() did not set shell_id"

        # Wait briefly for PTY output to land in the .pty stream file
        await asyncio.sleep(1.0)

        pty_output = _read_pty_stream(shell_id)

        assert pty_output, f"No PTY output captured — shell_id={shell_id}"

        assert "200~" not in pty_output, (
            f"Leaked bracketed paste start '200~' in PTY output:\n{pty_output[:400]}"
        )
        assert "201~" not in pty_output, (
            f"Leaked bracketed paste end '201~' in PTY output:\n{pty_output[:400]}"
        )
    finally:
        await process.close()
