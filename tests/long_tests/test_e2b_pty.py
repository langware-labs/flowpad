"""Smoke tests for E2BComputeProvider — boots a real E2B sandbox and runs a PTY.

Skipped unless E2B_KEY is set. Each test owns its sandbox and cleans up on exit.
Pattern adapted from FlowPad's hub/tests/long_tests/test_claude_code_e2b.py
(`run_command_via_pty`), but exercises our provider rather than the raw SDK.
"""
from __future__ import annotations

import asyncio
import os
import uuid

import pytest

E2B_KEY = os.getenv("E2B_KEY")
pytestmark = pytest.mark.skipif(not E2B_KEY, reason="E2B_KEY not set")


@pytest.fixture()
async def provider():
    """Yield a fresh E2BComputeProvider; ensure all sandboxes are killed at teardown."""
    from flow_sdk.compute.providers.e2b.provider import E2BComputeProvider

    p = E2BComputeProvider()
    try:
        yield p
    finally:
        await p.reset()


async def _wait_until(predicate, timeout: float = 10.0, interval: float = 0.1):
    """Poll predicate() until true or timeout."""
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        if predicate():
            return True
        await asyncio.sleep(interval)
    return False


@pytest.mark.timeout(90)
async def test_e2b_pty_boot_and_whoami(provider):
    """Boot a sandbox PTY, send `whoami`, expect `user` in the output stream."""
    node_id = f"test-node-{uuid.uuid4().hex[:8]}"
    session_id = f"test-sess-{uuid.uuid4().hex[:8]}"
    chunks: list[bytes] = []

    def on_output(data: bytes) -> None:
        chunks.append(data)

    result = await provider.get_or_create_pty_session(
        provider_node_id=node_id,
        session_id=session_id,
        on_output=on_output,
        rows=24,
        cols=80,
    )

    assert result["provider"] == "e2b"
    assert result["sandbox_id"]
    assert result["pid"]

    # Wait for shell prompt
    assert await _wait_until(lambda: any(b"$" in c or b"#" in c for c in chunks), timeout=15.0), (
        f"No shell prompt seen. Chunks so far: {[c[:120] for c in chunks]}"
    )

    chunks.clear()
    await provider.send_pty_input(node_id, session_id, b"whoami\n", 80, 24)

    assert await _wait_until(lambda: any(b"user" in c for c in chunks), timeout=10.0), (
        f"`whoami` did not return `user`. Output: {b''.join(chunks).decode(errors='replace')}"
    )


@pytest.mark.timeout(90)
async def test_e2b_pty_close_kills_sandbox(provider):
    """Closing the last PTY on a node should kill the underlying sandbox."""
    from e2b import AsyncSandbox
    from e2b.exceptions import SandboxException

    node_id = f"test-node-{uuid.uuid4().hex[:8]}"
    session_id = f"test-sess-{uuid.uuid4().hex[:8]}"

    result = await provider.get_or_create_pty_session(
        provider_node_id=node_id,
        session_id=session_id,
        on_output=lambda _: None,
        rows=24,
        cols=80,
    )
    sandbox_id = result["sandbox_id"]

    # Sandbox should be tracked.
    assert node_id in provider._sandboxes
    assert provider.is_pty_alive(node_id, session_id)

    # Close the only PTY → sandbox should be reaped.
    await provider.close_pty_session(node_id, session_id)
    assert not provider.is_pty_alive(node_id, session_id)
    assert node_id not in provider._sandboxes

    # Confirm via E2B API: the sandbox is gone — either an explicit non-running
    # state or a 404 SandboxNotFoundException (the SDK's signal for a killed sandbox).
    try:
        info = await AsyncSandbox.get_info(sandbox_id=sandbox_id, api_key=E2B_KEY)
        assert str(info.state).lower() != "running", (
            f"Sandbox {sandbox_id} still running after close: state={info.state}"
        )
    except SandboxException as e:
        # 404 / SandboxNotFoundException — the sandbox was killed. Pass.
        assert "not found" in str(e).lower() or "404" in str(e), (
            f"Unexpected SandboxException for killed sandbox: {e}"
        )


@pytest.mark.timeout(90)
async def test_e2b_pty_handle_write_and_output(provider):
    """Exercise the Pty handle interface — pty.write() and pty.output() — used by
    backend Shell entity flows (`shell.compute_node.get_pty(shell.id).write(...)`).

    Mirrors the wiring that pty_actions.start_machine_pty_session sets up: the
    provider's on_output callback feeds session_state.output_queues, which is what
    Pty.output() reads from.
    """
    from flow_sdk.compute.providers.desktop.pty_session_manager import session_manager

    cn_id = f"test-cn-{uuid.uuid4().hex[:8]}"
    node_id = f"test-node-{uuid.uuid4().hex[:8]}"
    shell_id = f"test-shell-{uuid.uuid4().hex[:8]}"
    pty_key = (cn_id, node_id, shell_id)

    # Register the session_state first so its output_queues exist when on_output fires.
    session_state = await session_manager.generate_session(pty_key, cn_id, None, 80, 24)
    loop = asyncio.get_event_loop()

    def on_output(data: bytes) -> None:
        for q in session_state.output_queues:
            asyncio.run_coroutine_threadsafe(q.put(data), loop)

    try:
        await provider.get_or_create_pty_session(
            provider_node_id=node_id,
            session_id=shell_id,
            on_output=on_output,
            rows=24, cols=80,
        )

        # Acquire the Pty handle — same call path as ComputeNode.get_pty(shell_id).
        pty = provider.get_pty_session(cn_id, shell_id)
        assert pty is not None, "get_pty_session should return an E2BPtySession"
        assert pty.shell_id == shell_id
        assert pty.is_alive

        # Drain initial prompt + send `whoami` via the handle interface.
        await pty.write(b"whoami\n")

        received: list[bytes] = []

        async def collect_until(needle: bytes, timeout: float = 10.0) -> bool:
            async def _loop():
                async for chunk in pty.output():
                    received.append(chunk)
                    if any(needle in c for c in received):
                        return
            try:
                await asyncio.wait_for(_loop(), timeout=timeout)
                return True
            except asyncio.TimeoutError:
                return False

        assert await collect_until(b"user", timeout=10.0), (
            f"`whoami` via pty.write() did not surface `user` in pty.output(). "
            f"Got: {b''.join(received).decode(errors='replace')[:400]}"
        )
    finally:
        # Drain queues so the output() iterator can exit, then close.
        for q in session_state.output_queues:
            await q.put(None)
        await session_manager.close_session(pty_key)


@pytest.mark.timeout(90)
async def test_e2b_pty_two_sessions_share_sandbox(provider):
    """Two PTYs on the same compute node should share one E2B sandbox."""
    node_id = f"test-node-{uuid.uuid4().hex[:8]}"
    s1 = f"sess-a-{uuid.uuid4().hex[:8]}"
    s2 = f"sess-b-{uuid.uuid4().hex[:8]}"

    r1 = await provider.get_or_create_pty_session(node_id, s1, lambda _: None, 24, 80)
    r2 = await provider.get_or_create_pty_session(node_id, s2, lambda _: None, 24, 80)

    assert r1["sandbox_id"] == r2["sandbox_id"], (
        f"Expected same sandbox, got {r1['sandbox_id']} vs {r2['sandbox_id']}"
    )
    assert r1["pid"] != r2["pid"], "Distinct PTYs must have distinct pids"

    # Closing one should NOT kill the sandbox while the other is alive.
    await provider.close_pty_session(node_id, s1)
    assert node_id in provider._sandboxes
    assert provider.is_pty_alive(node_id, s2)
