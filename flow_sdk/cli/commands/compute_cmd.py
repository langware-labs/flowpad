"""CLI subcommand group: `flow compute {connect, worker, list}`.

`flow compute connect <container>` — provisions a @docker-<name> ComputeNode,
installs flow_sdk into the container, prints the worker start command.

`flow compute worker` — runs inside the container; dials out to the outer
server via WS (reads MACHINE_ID/FLOW_CONNECT_KEY/FLOW_OUTER_URL from env).

`flow compute list` — shows registered docker compute nodes and their status.
"""

from __future__ import annotations

import os
import secrets
import shutil
import subprocess
import uuid

import typer

from flow_sdk.cli.commands._common import discover_port as _discover_port

_WORKER_READY_FIFO = "/tmp/flowpad-worker-ready"
_WORKER_CONNECTED_FILE = "/tmp/flowpad-worker-connected"
_WORKER_LOG = "/tmp/flowpad-worker.log"
_WORKER_PID_FILE = "/tmp/flowpad-worker.pid"
_WORKER_SUPERVISOR_PID_FILE = "/tmp/flowpad-worker-supervisor.pid"

compute_app = typer.Typer(
    name="compute",
    help="Manage Docker compute nodes.",
    add_completion=False,
    invoke_without_command=True,
)


@compute_app.callback()
def _compute_callback(ctx: typer.Context) -> None:
    if ctx.invoked_subcommand is None:
        typer.echo(ctx.get_help())


@compute_app.command("connect")
def compute_connect(
    container: str = typer.Argument(..., help="Name or ID of a running Docker container"),
    start: bool = typer.Option(False, "--start", help="Also start the worker inside the container"),
) -> None:
    """Connect a running Docker container as a compute node.

    Installs flow_sdk into the container and registers a @docker-<name>
    ComputeNode in the outer server's DB. After this, either pass --start or
    manually run: docker exec -d <container> flow compute worker
    """
    docker = shutil.which("docker")
    if not docker:
        typer.echo("ERROR: `docker` not found in PATH", err=True)
        raise typer.Exit(1)

    # 1. Verify container is running
    result = subprocess.run(
        [docker, "inspect", "-f", "{{.State.Running}}", container],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 or "true" not in result.stdout.lower():
        typer.echo(f"ERROR: container '{container}' is not running", err=True)
        raise typer.Exit(1)

    # 2. Generate credentials
    machine_id = uuid.uuid4().hex
    secret = secrets.token_urlsafe(32)

    # 3. Find the wheel
    wheel_path = _find_wheel()
    if not wheel_path:
        typer.echo("ERROR: could not find flowpad wheel. Run `uv build --wheel --out-dir dist/` first.", err=True)
        raise typer.Exit(1)

    # 4. Find install script
    install_script = _find_install_script()
    if not install_script:
        typer.echo("ERROR: install_flow_on_docker.sh not found", err=True)
        raise typer.Exit(1)

    # 5. docker cp wheel + install script — independent, run in parallel.
    typer.echo(f"  Copying wheel + install script into {container}...")
    cps = [
        subprocess.Popen([docker, "cp", wheel_path, f"{container}:/tmp/"]),
        subprocess.Popen([docker, "cp", install_script, f"{container}:/tmp/install_flow_on_docker.sh"]),
    ]
    for p in cps:
        if p.wait() != 0:
            typer.echo("ERROR: docker cp failed", err=True)
            raise typer.Exit(1)

    # 6. docker exec install
    typer.echo(f"  Installing flow_sdk inside {container}...")
    r = subprocess.run(
        [docker, "exec", container, "bash", "/tmp/install_flow_on_docker.sh"],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        typer.echo(f"ERROR: install failed:\n{r.stderr}", err=True)
        raise typer.Exit(1)
    typer.echo(f"  {r.stdout.strip()}")

    # 7. Write /etc/flowpad/machine.env inside container
    outer_url = _outer_ws_url()
    env_content = (
        f"MACHINE_ID={machine_id}\nFLOW_CONNECT_KEY={secret}\nFLOW_OUTER_URL={outer_url}\nCONTAINER_NAME={container}\n"
    )
    subprocess.run(
        [
            docker,
            "exec",
            container,
            "bash",
            "-c",
            f"mkdir -p /etc/flowpad && cat > /etc/flowpad/machine.env << 'ENVEOF'\n{env_content}ENVEOF",
        ],
        check=True,
    )

    # 8. Create outer ComputeNode entity
    import asyncio

    cn_id = asyncio.run(_create_docker_compute_node(container, machine_id, secret))
    typer.echo(f"  @docker-{container} compute node created: {cn_id}")

    # 9. Optionally start the worker
    if start:
        typer.echo(f"  Starting worker inside {container}...")
        ready, detail = _start_worker_and_wait_until_connected(docker, container)
        if not ready:
            typer.echo(f"ERROR: worker failed to connect:\n{detail}", err=True)
            raise typer.Exit(1)
        typer.echo("  Worker connected (background)")
    else:
        typer.echo(
            f"\n  To start the worker:\n"
            f"    docker exec -d {container} bash -c "
            f"'set -a; source /etc/flowpad/machine.env; set +a; /opt/flow/bin/flow compute worker'"
        )


@compute_app.command("worker")
def compute_worker() -> None:
    """Run the inner-container compute worker (reads env from MACHINE_ID/FLOW_CONNECT_KEY/FLOW_OUTER_URL)."""
    from flow_sdk.compute.providers.docker.worker import run

    run()


@compute_app.command("list")
def compute_list() -> None:
    """List registered docker compute nodes."""
    from flow_sdk.compute.providers.docker.docker_registry import list_workers

    workers = list_workers()
    if not workers:
        typer.echo("No docker compute workers connected.")
        return
    for w in workers:
        typer.echo(f"  {w['machine_id'][:12]}  container={w['container_name']}")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _outer_ws_url() -> str:
    """Docker-worker callback for the FLOW_INSTANCE-selected live backend."""
    return f"ws://host.docker.internal:{_discover_port()}/api/v1/compute/ws"


def _worker_supervisor_script() -> str:
    """Run the worker and signal its first completed outer-server handshake.

    The FIFO is an event barrier, not a timer/poll: ``compute connect --start``
    returns only after the server has registered the worker and replied with
    ``compute_connected``. The worker writes that exact protocol event; the
    detached supervisor writes a failure marker only when the worker exits
    before reaching it.
    """
    return f"""
set -uo pipefail
ready_fifo={_WORKER_READY_FIFO!r}
connected_file={_WORKER_CONNECTED_FILE!r}
log_file={_WORKER_LOG!r}
worker_pid_file={_WORKER_PID_FILE!r}
supervisor_pid_file={_WORKER_SUPERVISOR_PID_FILE!r}
printf '%s\\n' "$$" > "$supervisor_pid_file"
set -a
source /etc/flowpad/machine.env
set +a
FLOW_WORKER_READY_PATH="$ready_fifo" FLOW_WORKER_CONNECTED_PATH="$connected_file" \
  /opt/flow/bin/flow compute worker > "$log_file" 2>&1 &
worker_pid="$!"
printf '%s\\n' "$worker_pid" > "$worker_pid_file"
wait "$worker_pid"
worker_rc=$?
if [ ! -f "$connected_file" ]; then
  printf 'failed:%s\\n' "$worker_rc" > "$ready_fifo"
fi
exit "$worker_rc"
""".strip()


def _worker_prepare_script() -> str:
    """Retire a worker started by this CLI and create a fresh readiness FIFO."""
    return f"""
# This container is a dedicated compute worker. Retire exact worker commands
# left by older CLI versions that predate the pid files below.
for proc in /proc/[0-9]*; do
  old_pid="${{proc##*/}}"
  if [ "$old_pid" = "$$" ]; then
    continue
  fi
  old_cmd="$(tr '\\0' ' ' < "$proc/cmdline" 2>/dev/null || true)"
  case "$old_cmd" in
    *'/opt/flow/bin/flow compute worker'*) kill "$old_pid" 2>/dev/null || true ;;
  esac
done
for pid_file in {_WORKER_PID_FILE!r} {_WORKER_SUPERVISOR_PID_FILE!r}; do
  if [ -f "$pid_file" ]; then
    IFS= read -r old_pid < "$pid_file" || true
    case "$old_pid" in
      ''|*[!0-9]*) ;;
      *) kill "$old_pid" 2>/dev/null || true ;;
    esac
  fi
done
rm -f {_WORKER_READY_FIFO!r} {_WORKER_CONNECTED_FILE!r} {_WORKER_PID_FILE!r} {_WORKER_SUPERVISOR_PID_FILE!r} /tmp/flowpad-worker-output
mkfifo {_WORKER_READY_FIFO!r}
: > {_WORKER_LOG!r}
""".strip()


def _worker_log(docker: str, container: str) -> str:
    result = subprocess.run(
        [docker, "exec", container, "cat", _WORKER_LOG],
        capture_output=True,
        text=True,
    )
    return (result.stdout or result.stderr or "worker produced no log output").strip()


def _start_worker_and_wait_until_connected(docker: str, container: str) -> tuple[bool, str]:
    """Start one detached worker and block on its exact registration event."""
    prepared = subprocess.run(
        [docker, "exec", container, "bash", "-c", _worker_prepare_script()],
        capture_output=True,
        text=True,
    )
    if prepared.returncode != 0:
        return False, (prepared.stderr or prepared.stdout or "could not prepare worker").strip()

    started = subprocess.run(
        [docker, "exec", "-d", container, "bash", "-c", _worker_supervisor_script()],
        capture_output=True,
        text=True,
    )
    if started.returncode != 0:
        return False, (started.stderr or started.stdout or "could not start worker").strip()

    # Exact synchronization: the supervisor writes once, after the worker has
    # received ``compute_connected``. No sleep, retry, polling, or widened
    # timeout is involved.
    registration = subprocess.run(
        [docker, "exec", container, "cat", _WORKER_READY_FIFO],
        capture_output=True,
        text=True,
    )
    marker = registration.stdout.strip()
    if registration.returncode == 0 and marker == "ready":
        return True, ""
    return False, _worker_log(docker, container)


async def _create_docker_compute_node(container_name: str, machine_id: str, secret: str) -> str:
    from flow_sdk.builtin.faas.compute_node import ComputeNode
    from flow_sdk.config import ComputeProviderType, StorageProvider
    from flow_sdk.db.database import init_db
    from flow_sdk.flowpad_types.runtime_environment import OSType, RuntimeEnvironment

    await init_db()

    uname = f"docker-{container_name}"
    existing = await ComputeNode.get_one({"uname": uname})
    if existing:
        existing.node_provider_id = machine_id
        existing.node_config = {**(existing.node_config or {}), "secret": secret, "container_name": container_name}
        await existing.save()
        return str(existing.id)

    cn = ComputeNode(
        uname=uname,
        name=f"@docker-{container_name}",
        runtime=RuntimeEnvironment(name="docker_container_runtime", os_type=OSType.LINUX),
        node_provider_type=ComputeProviderType.DOCKER,
        fs_storage_provider=StorageProvider.SANDBOX,
        fs_storage_mount_path="/root",
        visitor_role="owner",
        node_provider_id=machine_id,
        node_config={"secret": secret, "container_name": container_name},
    )
    await cn.save()
    return str(cn.id)


def _find_wheel() -> str | None:
    import flow_sdk

    pkg_dir = os.path.dirname(os.path.dirname(os.path.abspath(flow_sdk.__file__)))
    dist_dir = os.path.join(pkg_dir, "dist")
    if os.path.isdir(dist_dir):
        wheels = sorted(
            [f for f in os.listdir(dist_dir) if f.endswith(".whl")],
            key=lambda f: os.path.getmtime(os.path.join(dist_dir, f)),
            reverse=True,
        )
        if wheels:
            return os.path.join(dist_dir, wheels[0])
    return None


def _find_install_script() -> str | None:
    import flow_sdk

    pkg_dir = os.path.dirname(os.path.dirname(os.path.abspath(flow_sdk.__file__)))
    candidate = os.path.join(pkg_dir, "install_flow_on_docker.sh")
    if os.path.isfile(candidate):
        return candidate
    return None
