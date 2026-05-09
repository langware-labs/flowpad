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
from flow_sdk.compute.providers.desktop.pty_replay_buffer import replay_buffer


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

        # Wait briefly for PTY output to land in the replay buffer
        await asyncio.sleep(1.0)

        # Replay buffer is keyed on the ComputeNode's actual node_provider_id.
        pty_key = (cn.id, cn.node_provider_id, shell_id)
        chunks = replay_buffer.get_replay(pty_key, since_seq=0)
        pty_output = "".join(c.data.decode("utf-8", errors="replace") for c in chunks)

        assert pty_output, f"No PTY output captured — pty_key={pty_key}"

        assert "200~" not in pty_output, (
            f"Leaked bracketed paste start '200~' in PTY output:\n{pty_output[:400]}"
        )
        assert "201~" not in pty_output, (
            f"Leaked bracketed paste end '201~' in PTY output:\n{pty_output[:400]}"
        )
    finally:
        await process.close()
