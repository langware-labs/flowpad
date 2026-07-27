"""A6 pinning test — a dead PTY's input/resize retry must NOT respawn a bare shell.

Interface invariant #7 (docs/interface/README.md): PTY (re)creation belongs to
``_perform_open`` / ``start_pty`` / ``pty_recovery`` — they hold ``spawn_args`` and
the per-shell open lock. The provider's ``send_pty_input`` / ``resize_pty`` retry
path used to call ``get_or_create_pty_session`` WITHOUT ``spawn_args`` when it found
the PTY dead, spawning a default ``$SHELL`` — a bare shell over the agent's session.

This drives the real ``LocalComputeProvider`` with a real ``/bin/sh`` PTY (no mocks):
spawn WITH spawn_args, SIGKILL the OS process while leaving the provider's stale
entry in place (the exact "worker crashed mid-session" state — a full restart empties
the map, a crash does not), then a keystroke / resize must surface the death (raise)
and leave NO new bare-shell PTY behind. Recovery via a fresh spawn_args spawn still
works.

Fails pre-fix: the retry respawned a live bare ``/bin/sh`` and the entry survived.
"""

import asyncio
import os
import signal
import sys
import uuid

import pytest

from flow_sdk.compute.providers.desktop.provider import LocalComputeProvider

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="uses a /bin/sh PTY")


def _noop_output(_data: bytes) -> None:
    pass


async def _spawn(provider, node, shell_id, tmp_path):
    await provider.get_or_create_pty_session(
        node,
        shell_id,
        on_output=_noop_output,
        rows=24,
        cols=80,
        working_dir=str(tmp_path),
        spawn_args=["/bin/sh"],
    )


async def _spawn_then_crash(provider, node, shell_id, tmp_path):
    """Spawn a real PTY, then SIGKILL the OS process while KEEPING the provider's
    ``_pty_processes`` entry (crash-mid-session state). Returns the (node, shell) key."""
    await _spawn(provider, node, shell_id, tmp_path)
    key = (node, shell_id)
    assert key in provider._pty_processes
    proc_obj = provider._pty_processes[key]["process"]
    os.kill(provider._pty_processes[key]["pid"], signal.SIGKILL)
    for _ in range(500):  # bounded wait for the OS to reap — no timeout inflation
        if not proc_obj.isalive():
            break
        await asyncio.sleep(0.02)
    assert not proc_obj.isalive(), "PTY process should be dead after SIGKILL"
    assert key in provider._pty_processes, "crash must leave the stale entry (not a restart)"
    return key


# do not increase timeout without approval
@pytest.mark.timeout(30)
@pytest.mark.asyncio
async def test_send_pty_input_on_dead_pty_raises_and_does_not_bare_respawn(tmp_path):
    provider = LocalComputeProvider()
    provider.default_working_dir = str(tmp_path)
    node = "test-provider-node"
    shell_id = f"shell-{uuid.uuid4()}"
    key = await _spawn_then_crash(provider, node, shell_id, tmp_path)

    with pytest.raises(RuntimeError):
        await provider.send_pty_input(node, shell_id, b"echo pwned\n", cols=80, rows=24)

    # The dead session is cleaned up, NOT repopulated with a bare $SHELL.
    assert key not in provider._pty_processes, "input retry must not bare-respawn a dead PTY"
    assert provider.is_pty_alive(node, shell_id) is False


# do not increase timeout without approval
@pytest.mark.timeout(30)
@pytest.mark.asyncio
async def test_resize_pty_on_dead_pty_raises_and_does_not_bare_respawn(tmp_path):
    provider = LocalComputeProvider()
    provider.default_working_dir = str(tmp_path)
    node = "test-provider-node"
    shell_id = f"shell-{uuid.uuid4()}"
    key = await _spawn_then_crash(provider, node, shell_id, tmp_path)

    with pytest.raises(RuntimeError):
        await provider.resize_pty(node, shell_id, cols=100, rows=30)

    assert key not in provider._pty_processes, "resize retry must not bare-respawn a dead PTY"
    assert provider.is_pty_alive(node, shell_id) is False


# do not increase timeout without approval
@pytest.mark.timeout(30)
@pytest.mark.asyncio
async def test_recovery_respawn_with_spawn_args_still_works(tmp_path):
    """The owned respawn path (spawn_args carried) still produces a live PTY — the
    fix only removes the *bare* respawn from the input/resize retry."""
    provider = LocalComputeProvider()
    provider.default_working_dir = str(tmp_path)
    node = "test-provider-node"
    shell_id = f"shell-{uuid.uuid4()}"
    await _spawn_then_crash(provider, node, shell_id, tmp_path)

    # Surface the death through a keystroke (cleans up the stale entry)…
    with pytest.raises(RuntimeError):
        await provider.send_pty_input(node, shell_id, b"noop\n", cols=80, rows=24)
    assert provider.is_pty_alive(node, shell_id) is False

    # …then the recovery owner respawns WITH spawn_args → a real, live PTY.
    try:
        await _spawn(provider, node, shell_id, tmp_path)
        assert provider.is_pty_alive(node, shell_id) is True
    finally:
        await provider.close_pty_session(node, shell_id)
