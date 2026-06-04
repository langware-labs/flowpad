"""CLI subcommand group: `flow compute {connect, worker, list}`.

`flow compute connect <container>` — provisions a @docker-<name> ComputeNode,
installs flow_sdk into the container, prints the worker start command.

`flow compute worker` — runs inside the container; dials out to the outer
server via WS (reads MACHINE_ID/FLOW_CONNECT_KEY/FLOW_OUTER_URL from env).

`flow compute list` — shows registered docker compute nodes and their status.
"""
from __future__ import annotations
from flow_sdk.instance_settings import get_instance_settings

import os
import secrets
import shutil
import subprocess
import sys
import uuid

import typer

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
        capture_output=True, text=True,
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
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        typer.echo(f"ERROR: install failed:\n{r.stderr}", err=True)
        raise typer.Exit(1)
    typer.echo(f"  {r.stdout.strip()}")

    # 7. Write /etc/flowpad/machine.env inside container
    port = str(get_instance_settings().port)
    outer_url = f"ws://host.docker.internal:{port}/api/v1/compute/ws"
    env_content = (
        f"MACHINE_ID={machine_id}\n"
        f"FLOW_CONNECT_KEY={secret}\n"
        f"FLOW_OUTER_URL={outer_url}\n"
        f"CONTAINER_NAME={container}\n"
    )
    subprocess.run(
        [docker, "exec", container, "bash", "-c",
         f"mkdir -p /etc/flowpad && cat > /etc/flowpad/machine.env << 'ENVEOF'\n{env_content}ENVEOF"],
        check=True,
    )

    # 8. Create outer ComputeNode entity
    import asyncio
    cn_id = asyncio.run(_create_docker_compute_node(container, machine_id, secret))
    typer.echo(f"  @docker-{container} compute node created: {cn_id}")

    # 9. Optionally start the worker
    if start:
        typer.echo(f"  Starting worker inside {container}...")
        subprocess.run(
            [docker, "exec", "-d", container, "bash", "-c",
             "set -a; source /etc/flowpad/machine.env; set +a; /opt/flow/bin/flow compute worker"],
        )
        typer.echo("  Worker started (background)")
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
