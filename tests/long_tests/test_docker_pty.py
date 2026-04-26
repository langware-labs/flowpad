"""Integration tests for DockerComputeProvider — driven through the real Shell entity.

Mirrors `test_e2b_pty.py` in spirit: every test goes through
`Shell(...).save()` → `shell.start()` → `shell.compute_node.get_pty(shell.id).write(...)`.
No direct provider calls, no hand-built session_manager entries.

Unlike the E2B path (which talks to a cloud sandbox via SDK), the Docker path
requires an inbound WS from a worker running inside a container. So the fixture
stands up an in-process FastAPI with the `compute_register` route on an
ephemeral port and execs `flow compute worker` inside the test container,
pointing it at that port. The test container must already have flow_sdk
installed (run `flow compute connect <container>` once to prepare it).

Skipped unless `DOCKER_TEST_CONTAINER` is set and `docker` is available.
"""
from __future__ import annotations

import asyncio
import os
import secrets
import shutil
import subprocess
import sys
import uuid

import pytest

DOCKER_TEST_CONTAINER = os.getenv("DOCKER_TEST_CONTAINER")
DOCKER_BIN = shutil.which("docker")


def _skip_reason() -> str | None:
    if not DOCKER_TEST_CONTAINER:
        return "DOCKER_TEST_CONTAINER not set"
    if not DOCKER_BIN:
        return "docker binary not on PATH"
    r = subprocess.run(
        [DOCKER_BIN, "inspect", "-f", "{{.State.Running}}", DOCKER_TEST_CONTAINER],
        capture_output=True, text=True,
    )
    if r.returncode != 0 or "true" not in r.stdout.lower():
        return f"container '{DOCKER_TEST_CONTAINER}' is not running"
    return None


pytestmark = pytest.mark.skipif(_skip_reason() is not None, reason=_skip_reason() or "")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
async def docker_compute_node(initialize_test_db, unused_tcp_port):
    """Stand up an in-process compute-register WS on a free port, spawn a
    worker inside the test container that dials it, create the @docker-<name>
    ComputeNode, wait for the worker to register, yield the CN, then clean up.
    """
    import uvicorn
    from fastapi import FastAPI

    from flow_sdk.builtin.faas.compute_node import ComputeNode
    from flow_sdk.builtin.user import User
    from flow_sdk.compute.providers.docker import docker_registry
    from flow_sdk.config import ComputeProviderType, StorageProvider
    from flow_sdk.flowpad_types.runtime_environment import OSType, RuntimeEnvironment
    from flow_sdk.server.routes.compute_register import compute_register_router

    container = DOCKER_TEST_CONTAINER
    port = unused_tcp_port

    # 1. Ephemeral FastAPI serving /api/v1/compute/ws on `port`.
    app = FastAPI()
    app.include_router(compute_register_router)
    config = uvicorn.Config(app, host="0.0.0.0", port=port, log_level="warning", lifespan="off")
    server = uvicorn.Server(config)
    server_task = asyncio.create_task(server.serve())

    # Wait until the server is listening.
    for _ in range(100):
        if server.started:
            break
        await asyncio.sleep(0.05)
    else:
        server_task.cancel()
        pytest.fail("in-process compute/ws server failed to start within 5s")

    # 2. Generate creds + create outer ComputeNode entity.
    machine_id = uuid.uuid4().hex
    secret_val = secrets.token_urlsafe(32)

    user = await User.get_one({"uname": "local"})

    existing = await ComputeNode.get_one({"uname": f"docker-{container}"})
    if existing is not None:
        # Reuse but rotate creds for this test run.
        existing.node_provider_id = machine_id
        existing.node_config = {
            **(existing.node_config or {}),
            "secret": secret_val,
            "container_name": container,
        }
        await existing.save()
        cn = existing
        created_here = False
    else:
        cn = ComputeNode(
            uname=f"docker-{container}",
            name=f"@docker-{container}",
            runtime=RuntimeEnvironment(name="docker_container_runtime", os_type=OSType.LINUX),
            node_provider_type=ComputeProviderType.DOCKER,
            fs_storage_provider=StorageProvider.SANDBOX,
            fs_storage_mount_path="/root",
            visitor_role="owner",
            node_provider_id=machine_id,
            node_config={"secret": secret_val, "container_name": container},
        )
        await cn.save(owner=user)
        created_here = True

    # 3. Start the worker inside the container pointed at our port.
    outer_url = f"ws://host.docker.internal:{port}/api/v1/compute/ws"
    # Kill any prior worker in this container first (idempotent).
    subprocess.run(
        [DOCKER_BIN, "exec", container, "bash", "-lc", "pkill -f 'flow compute worker' || true"],
        capture_output=True,
    )
    start_cmd = (
        f"MACHINE_ID={machine_id} FLOW_CONNECT_KEY={secret_val} "
        f"FLOW_OUTER_URL={outer_url} CONTAINER_NAME={container} "
        f"nohup /opt/flow/bin/flow compute worker > /tmp/flow-worker.log 2>&1 &"
    )
    r = subprocess.run(
        [DOCKER_BIN, "exec", "-d", container, "bash", "-lc", start_cmd],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        server.should_exit = True
        await asyncio.wait_for(server_task, timeout=2.0)
        pytest.fail(f"failed to start worker in {container}: {r.stderr}")

    # 4. Wait up to 15s for the worker to register with our in-process server.
    for _ in range(150):
        if docker_registry.get(machine_id) is not None:
            break
        await asyncio.sleep(0.1)
    else:
        # Dump the worker log so we can see why.
        log = subprocess.run(
            [DOCKER_BIN, "exec", container, "cat", "/tmp/flow-worker.log"],
            capture_output=True, text=True,
        ).stdout
        server.should_exit = True
        await asyncio.wait_for(server_task, timeout=2.0)
        pytest.fail(f"worker did not register within 15s. Worker log:\n{log}")

    try:
        yield cn
    finally:
        # Teardown: kill worker in container, unregister, stop server, delete CN.
        subprocess.run(
            [DOCKER_BIN, "exec", container, "bash", "-lc", "pkill -f 'flow compute worker' || true"],
            capture_output=True,
        )
        await docker_registry.unregister(machine_id)
        server.should_exit = True
        try:
            await asyncio.wait_for(server_task, timeout=3.0)
        except asyncio.TimeoutError:
            server_task.cancel()
        if created_here:
            try:
                await cn.delete()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


from tests.long_tests._pty_helpers import write_and_collect, close_shell as _close_shell


async def _write_and_collect(pty, data, needle, timeout: float = 15.0):
    return await write_and_collect(pty, data, needle, timeout)


async def _make_shell(docker_cn, name_suffix: str):
    from flow_sdk.builtin.shell import Shell
    shell = Shell(
        name=f"test-{name_suffix}-{uuid.uuid4().hex[:6]}",
        compute_node_id=docker_cn.id,
        compute_node_uname=f"docker-{DOCKER_TEST_CONTAINER}",
    )
    await shell.save()
    return shell


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


# do not increase timeout without approval
@pytest.mark.timeout(30)
async def test_shell_on_docker_boots_linux_pty_via_shell_start(docker_compute_node):
    """`Shell.start()` on @docker-<name> must spawn a Linux PTY in the container.

    Walking-skeleton test: proves the whole path works end-to-end through the
    real Shell entity — NOT a direct provider call.
    """
    shell = await _make_shell(docker_compute_node, "boot")
    try:
        await shell.start(rows=24, cols=80)

        cn = shell.compute_node
        assert cn.node_provider_type == "docker", (
            f"Shell.compute_node.node_provider_type must be 'docker' for a docker shell; "
            f"got {cn.node_provider_type!r}"
        )
        assert cn.id == docker_compute_node.id

        pty = cn.get_pty(shell.id)
        assert pty is not None, f"No PTY handle for shell {shell.id} on @docker"
        assert pty.is_alive

        out = await _write_and_collect(pty, b"uname -s\n", b"Linux", timeout=15.0)
        assert b"Linux" in out, (
            f"`uname -s` through Shell→Docker PTY did not return Linux. Got: "
            f"{out.decode(errors='replace')[:400]}"
        )
        # Must be the container, not the host Mac.
        assert b"Darwin" not in out
    finally:
        await _close_shell(shell)


# do not increase timeout without approval
@pytest.mark.timeout(30)
async def test_shell_on_docker_pwd_is_expected_home(docker_compute_node):
    """`pwd` in a docker shell returns the container's current dir.

    python:3.11-slim runs bash as root, so the starting cwd is "/".
    We accept "/" OR "/root" OR "/home" to be robust across base images.
    """
    shell = await _make_shell(docker_compute_node, "pwd")
    try:
        await shell.start(rows=24, cols=80)
        pty = shell.compute_node.get_pty(shell.id)
        assert pty is not None

        # Unique marker so we don't match the echoed command itself.
        out = await _write_and_collect(
            pty, b"echo __PWD_IS_$(pwd)__\n", b"__PWD_IS_/", timeout=15.0,
        )
        decoded = out.decode(errors="replace")
        assert "__PWD_IS_/" in decoded, (
            f"pwd in a docker shell did not return a plausible cwd. Got: {decoded[:400]}"
        )
    finally:
        await _close_shell(shell)


# do not increase timeout without approval
@pytest.mark.timeout(30)
async def test_two_docker_shells_share_one_container(docker_compute_node):
    """Two Shells bound to the same @docker-<name> CN must share one container.

    Each Shell gets its own PTY (own pid), but they live in the same container
    (proven via matching `container` field in provider_session_data).
    """
    from flow_sdk.compute.providers.desktop.pty_session_manager import session_manager

    s1 = await _make_shell(docker_compute_node, "share-a")
    s2 = await _make_shell(docker_compute_node, "share-b")
    try:
        await s1.start(rows=24, cols=80)
        await s2.start(rows=24, cols=80)

        key1 = (docker_compute_node.id, docker_compute_node.node_provider_id, s1.id)
        key2 = (docker_compute_node.id, docker_compute_node.node_provider_id, s2.id)
        sess1 = session_manager.sessions.get(key1)
        sess2 = session_manager.sessions.get(key2)
        assert sess1 is not None, f"No session_manager entry for shell {s1.id}"
        assert sess2 is not None, f"No session_manager entry for shell {s2.id}"

        c1 = (sess1.provider_session_data or {}).get("container")
        c2 = (sess2.provider_session_data or {}).get("container")
        assert c1 and c2, (
            f"provider_session_data missing container: s1={sess1.provider_session_data} s2={sess2.provider_session_data}"
        )
        assert c1 == c2, f"Expected shared container, got {c1} vs {c2}"

        pid1 = (sess1.provider_session_data or {}).get("pid")
        pid2 = (sess2.provider_session_data or {}).get("pid")
        assert pid1 != pid2, "Distinct PTYs must have distinct pids"
    finally:
        await _close_shell(s1)
        await _close_shell(s2)


# do not increase timeout without approval
@pytest.mark.timeout(30)
async def test_shell_close_stops_pty_but_keeps_container(docker_compute_node):
    """Closing a docker Shell must stop its PTY but NOT kill the container.

    Containers are long-lived, user-managed resources. `shell.close()` should
    only tear down the shell's PTY session in the worker; the container (and
    the worker itself) stay up for other shells.
    """
    import shutil
    import subprocess
    from flow_sdk.compute.providers.desktop.pty_session_manager import session_manager

    docker_bin = shutil.which("docker")
    container_name = (docker_compute_node.node_config or {}).get("container_name", DOCKER_TEST_CONTAINER)

    shell = await _make_shell(docker_compute_node, "close")
    await shell.start(rows=24, cols=80)

    key = (docker_compute_node.id, docker_compute_node.node_provider_id, shell.id)
    sess = session_manager.sessions.get(key)
    assert sess is not None

    # Close the PTY through the real lifecycle.
    pty = shell.compute_node.get_pty(shell.id)
    if pty is not None:
        await pty.close()

    # Container must still be running.
    r = subprocess.run(
        [docker_bin, "inspect", "-f", "{{.State.Running}}", container_name],
        capture_output=True, text=True,
    )
    assert "true" in r.stdout.lower(), (
        f"Container {container_name} was killed by shell.close(); should have stayed alive"
    )

    # Session should be gone from session_manager.
    assert session_manager.sessions.get(key) is None


# do not increase timeout without approval
@pytest.mark.timeout(30)
async def test_shell_start_on_docker_uses_docker_provider_not_local(docker_compute_node):
    """Guard: the real Shell → real ComputeNode → real provider must resolve to
    DockerComputeProvider, not LocalComputeProvider. Fast structural check.
    """
    from flow_sdk.builtin.shell import Shell
    from flow_sdk.compute.providers.docker.provider import DockerComputeProvider

    shell = Shell(
        name=f"test-routing-{uuid.uuid4().hex[:6]}",
        compute_node_id=docker_compute_node.id,
        compute_node_uname=f"docker-{DOCKER_TEST_CONTAINER}",
    )
    await shell.save()
    try:
        assert await shell.ensure_live_compute_node_binding()
        cn = shell.compute_node
        assert cn.id == docker_compute_node.id
        assert cn.node_provider_type == "docker"
        assert isinstance(cn.compute_provider, DockerComputeProvider)
    finally:
        await _close_shell(shell)


# do not increase timeout without approval
@pytest.mark.timeout(30)
async def test_duplicate_worker_rejected(docker_compute_node):
    """A second worker dialling the same machine_id must be rejected.

    Without this defence, ghost workers from prior sessions (e.g. survivors
    of a server bounce, still running stale code) silently overwrote the
    registry and routed production PTY calls to themselves, causing 30s
    timeouts. The fix: `register()` raises `DuplicateWorkerError` when a
    live WorkerConn already owns the machine_id.
    """
    from flow_sdk.compute.providers.docker import docker_registry
    from flow_sdk.compute.providers.docker.docker_registry import DuplicateWorkerError

    machine_id = docker_compute_node.node_provider_id
    # Fixture's own worker should already be registered.
    live = docker_registry.get(machine_id)
    assert live is not None, "fixture worker not registered — cannot run rejection test"

    # Try to register again with a dummy ws — should raise.
    class _DummyWs:
        async def send_text(self, _):
            return
        async def close(self):
            return
        def iter_text(self):
            async def _gen():
                if False:
                    yield ""
            return _gen()

    with pytest.raises(DuplicateWorkerError):
        docker_registry.register(machine_id, _DummyWs(), "ghost")

    # The original registration must survive untouched.
    still_live = docker_registry.get(machine_id)
    assert still_live is live, "original WorkerConn was replaced despite rejection"
