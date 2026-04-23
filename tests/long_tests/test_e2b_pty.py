"""Integration tests for E2B sandbox shells — driven through the real Shell entity.

Everything goes through the production path:
  `Shell(...).save()` → `shell.start()` → `shell.compute_node.get_pty(shell.id).write(...)` → `pty.output()`

No direct calls to `E2BComputeProvider`. No hand-built `session_manager` entries.
If `Shell.start()` routes to the wrong provider, these tests will fail loudly —
which is the point. They are the integration pair for the provider-only smoke
tests that existed previously and gave false confidence.

Skipped unless `E2B_KEY` is set.
"""
from __future__ import annotations

import asyncio
import os
import sys
import uuid

import pytest

E2B_KEY = os.getenv("E2B_KEY")


def _e2b_reachable() -> bool:
    """True iff E2B_KEY is set AND the API is reachable — else skip.

    Avoids flaky failures when network egress to api.e2b.dev is blocked even
    though a key is configured (CI sandboxes, offline dev, etc).
    """
    if not E2B_KEY:
        return False
    try:
        import socket
        socket.setdefaulttimeout(2.0)
        sock = socket.create_connection(("api.e2b.dev", 443), timeout=2.0)
        sock.close()
        return True
    except OSError:
        return False


pytestmark = pytest.mark.skipif(
    not _e2b_reachable(),
    reason="E2B_KEY not set or api.e2b.dev unreachable",
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
async def sandbox_compute_node(initialize_test_db):
    """Get or create the @sandbox ComputeNode. Mirrors the real bootstrap wiring.

    Has node_provider_type=E2B so `ComputeNode.compute_provider` resolves to the
    E2B singleton and `Shell.start()` on this node should spin up an E2B sandbox.
    """
    from flow_sdk.builtin.faas.compute_node import ComputeNode
    from flow_sdk.builtin.user import User
    from flow_sdk.config import ComputeProviderType, StorageProvider
    from flow_sdk.flowpad_types.runtime_environment import OSType, RuntimeEnvironment

    created = False
    node = await ComputeNode.get_one({"uname": "sandbox"})
    if node is None:
        user = await User.get_one({"uname": "local"})
        node = ComputeNode(
            uname="sandbox",
            name="@sandbox",
            runtime=RuntimeEnvironment(name="e2b_sandbox_runtime", os_type=OSType.LINUX),
            node_provider_type=ComputeProviderType.E2B,
            fs_storage_provider=StorageProvider.SANDBOX,
            fs_storage_mount_path="/home/user",
            visitor_role="owner",
        )
        await node.save(owner=user)
        created = True

    # Ensure the node has a provider_node_id (used as a stable cache key for the
    # E2B sandbox instance in the provider's dicts).
    if not node.node_provider_id:
        node.node_provider_id = "sandbox_" + str(uuid.uuid4())
        await node.save()

    yield node

    if created:
        await node.delete()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


from tests.long_tests._pty_helpers import write_and_collect as _write_and_collect, close_shell as _close_shell


async def _make_shell(sandbox_cn, name_suffix: str):
    """Construct + save a Shell bound to the @sandbox ComputeNode."""
    from flow_sdk.builtin.shell import Shell

    shell = Shell(
        name=f"test-{name_suffix}-{uuid.uuid4().hex[:6]}",
        compute_node_id=sandbox_cn.id,
        compute_node_uname="sandbox",
    )
    await shell.save()
    return shell


# ---------------------------------------------------------------------------
# Tests — all go through the real Shell entity, no mocks, no injections
# ---------------------------------------------------------------------------


@pytest.mark.timeout(90)
async def test_shell_on_sandbox_boots_linux_pty_via_shell_start(sandbox_compute_node):
    """`Shell.start()` on @sandbox must spawn a real E2B Linux PTY.

    Catches the bug where `Shell.compute_node` was hardcoded to a synthetic
    local CN regardless of the shell's actual binding — which caused the PTY
    to be a host-macOS zsh instead of the sandbox's bash.
    """
    shell = await _make_shell(sandbox_compute_node, "boot")
    try:
        await shell.start(rows=24, cols=80)

        # The provider that actually spawned the PTY should be E2B — NOT local.
        # This is the key invariant that was broken.
        cn = shell.compute_node
        assert cn.node_provider_type == "e2b", (
            f"Shell.compute_node.node_provider_type must be 'e2b' for a sandbox shell; "
            f"got {cn.node_provider_type!r}. Likely the synthetic-local fallback is back."
        )
        assert cn.id == sandbox_compute_node.id, (
            f"Shell.compute_node.id mismatch: got {cn.id}, expected {sandbox_compute_node.id}"
        )

        pty = cn.get_pty(shell.id)
        assert pty is not None, f"No PTY handle for shell {shell.id} on @sandbox"
        assert pty.is_alive

        # Send `uname -s` through the real pty handle and read back via pty.output().
        out = await _write_and_collect(pty, b"uname -s\n", b"Linux", timeout=15.0)
        assert b"Linux" in out, (
            f"`uname -s` through Shell→PTY did not return Linux. Got: "
            f"{out.decode(errors='replace')[:400]}"
        )
        # Defence-in-depth: if the synthetic-local fallback sneaks back in, the
        # PTY would be macOS and we'd see Darwin.
        assert b"Darwin" not in out
    finally:
        await _close_shell(shell)


@pytest.mark.timeout(90)
async def test_shell_on_sandbox_pwd_is_home_user(sandbox_compute_node):
    """`pwd` in a sandbox shell must return /home/user (the E2B default cwd)."""
    shell = await _make_shell(sandbox_compute_node, "pwd")
    try:
        await shell.start(rows=24, cols=80)
        pty = shell.compute_node.get_pty(shell.id)
        assert pty is not None

        out = await _write_and_collect(pty, b"pwd\n", b"/home/user", timeout=15.0)
        assert b"/home/user" in out, (
            f"pwd in a sandbox shell did not return /home/user. Got: "
            f"{out.decode(errors='replace')[:400]}"
        )
    finally:
        await _close_shell(shell)


@pytest.mark.timeout(120)
async def test_two_sandbox_shells_share_one_e2b_sandbox(sandbox_compute_node):
    """Two Shells bound to the same @sandbox CN must share one E2B sandbox.

    Each Shell gets its own PTY (own pid), but they live inside the same E2B
    sandbox. Proven via provider_session_data exposed on the shared
    session_manager state.
    """
    from flow_sdk.compute.providers.desktop.pty_session_manager import session_manager

    s1 = await _make_shell(sandbox_compute_node, "share-a")
    s2 = await _make_shell(sandbox_compute_node, "share-b")
    try:
        await s1.start(rows=24, cols=80)
        await s2.start(rows=24, cols=80)

        key1 = (sandbox_compute_node.id, sandbox_compute_node.node_provider_id, s1.id)
        key2 = (sandbox_compute_node.id, sandbox_compute_node.node_provider_id, s2.id)
        sess1 = session_manager.sessions.get(key1)
        sess2 = session_manager.sessions.get(key2)
        assert sess1 is not None, f"No session_manager entry for shell {s1.id}"
        assert sess2 is not None, f"No session_manager entry for shell {s2.id}"

        sid1 = (sess1.provider_session_data or {}).get("sandbox_id")
        sid2 = (sess2.provider_session_data or {}).get("sandbox_id")
        assert sid1 and sid2, (
            f"provider_session_data missing sandbox_id: s1={sess1.provider_session_data} s2={sess2.provider_session_data}"
        )
        assert sid1 == sid2, f"Expected shared E2B sandbox, got {sid1} vs {sid2}"

        pid1 = (sess1.provider_session_data or {}).get("pid")
        pid2 = (sess2.provider_session_data or {}).get("pid")
        assert pid1 != pid2, "Distinct PTYs must have distinct pids"
    finally:
        await _close_shell(s1)
        await _close_shell(s2)


@pytest.mark.timeout(90)
async def test_shell_close_kills_sandbox_when_last_pty_leaves(sandbox_compute_node):
    """Closing the only sandbox Shell must reap the underlying E2B sandbox."""
    from e2b import AsyncSandbox
    from e2b.exceptions import SandboxException
    from flow_sdk.compute.providers.desktop.pty_session_manager import session_manager

    shell = await _make_shell(sandbox_compute_node, "close")
    await shell.start(rows=24, cols=80)
    key = (sandbox_compute_node.id, sandbox_compute_node.node_provider_id, shell.id)
    sess = session_manager.sessions.get(key)
    assert sess is not None
    sandbox_id = (sess.provider_session_data or {}).get("sandbox_id")
    assert sandbox_id, f"provider_session_data missing sandbox_id: {sess.provider_session_data}"

    # Close the shell through its real lifecycle method.
    await shell.close() if hasattr(shell, "close") else None
    pty = shell.compute_node.get_pty(shell.id)
    if pty is not None:
        await pty.close()

    # E2B cloud-side: sandbox gone (404) or at minimum not running.
    try:
        info = await AsyncSandbox.get_info(sandbox_id=sandbox_id, api_key=E2B_KEY)
        assert str(info.state).lower() != "running", (
            f"Sandbox {sandbox_id} still running after shell close: state={info.state}"
        )
    except SandboxException as e:
        assert "not found" in str(e).lower() or "404" in str(e), (
            f"Unexpected SandboxException: {e}"
        )


@pytest.mark.timeout(60)
async def test_shell_start_on_sandbox_uses_e2b_provider_not_local(sandbox_compute_node):
    """Guard: `shell.compute_node.compute_provider` must be the E2B singleton.

    Fast structural check (no sandbox boot) that pins the routing — if this fails,
    Shell.compute_node is falling back to the synthetic local CN again.
    """
    from flow_sdk.compute.providers.e2b.provider import E2BComputeProvider

    shell = await _make_shell(sandbox_compute_node, "routing")
    try:
        # Must resolve the binding first — the sync `compute_node` property
        # returns the real CN only after `ensure_live_compute_node_binding()`
        # caches it. `Shell.start()` calls that internally; here we exercise
        # the binding step directly without booting a sandbox.
        assert await shell.ensure_live_compute_node_binding()
        cn = shell.compute_node
        assert cn.id == sandbox_compute_node.id
        assert cn.node_provider_type == "e2b"
        assert isinstance(cn.compute_provider, E2BComputeProvider), (
            f"Shell.compute_node.compute_provider must be E2B, got {type(cn.compute_provider).__name__}"
        )
    finally:
        await _close_shell(shell)
