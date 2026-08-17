"""`flow connect` — make THIS machine a hub compute node.

1. Requires a hub login (`flow auth login`).
2. Finds — or creates and sets up — the hub ComputeNode that stands for this
   machine (``node_provider=user_machine``, keyed by this machine's stable id).
3. Starts the local Flow server headless (no browser), so the hub's workspace
   tooling has something to talk to on ``127.0.0.1:<port>``.
4. Serves the machine to the hub over WebSocket until Ctrl-C.

From the hub's point of view the node is then just another sandbox: the same
tools and flows that drive an E2B box drive this one.
"""

from __future__ import annotations

import asyncio
import logging
import platform
import time
import uuid
from pathlib import Path
from typing import Any, Optional

import typer

from flow_sdk.cli.commands._docker_enroll import write_marker

WORKSPACE_FLAVOR = "workspace"


MACHINE_ID_FILE = Path.home() / ".flow" / "machine_id"


def _machine_id() -> str:
    """A stable enrollment id for this machine, minted once and kept in ``~/.flow``.

    Not the ``X-Machine-ID`` fingerprint: that hashes ``uuid.getnode()``, which on
    some hosts (macOS with no resolvable hardware MAC) is a fresh random value per
    process — and an id that moves would enrol a new node on every ``flow connect``.
    """
    try:
        existing = MACHINE_ID_FILE.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        existing = ""
    if existing:
        return existing
    minted = uuid.uuid4().hex
    MACHINE_ID_FILE.parent.mkdir(parents=True, exist_ok=True)
    MACHINE_ID_FILE.write_text(minted + "\n", encoding="utf-8")
    return minted


def _default_node_name() -> str:
    return f"@{platform.node().split('.')[0] or 'my-machine'}"


def _node_matches(node: dict[str, Any], machine_id: str) -> bool:
    from flow_sdk.config import ComputeProviderType

    if node.get("node_provider") != ComputeProviderType.USER_MACHINE.value:
        return False
    config = node.get("node_config") or {}
    return isinstance(config, dict) and config.get("machine_id") == machine_id


async def find_existing_node(machine_id: str) -> Optional[dict[str, Any]]:
    """The hub ComputeNode already standing for this machine, if any."""
    from flow_sdk.cloud_client.transport.hub_http import hub_get
    from flow_sdk.schema.types import EntityType

    nodes = await hub_get(EntityType.COMPUTE_NODE)
    if not isinstance(nodes, list):
        return None
    for node in nodes:
        if isinstance(node, dict) and _node_matches(node, machine_id):
            return node
    return None


def _node_config(machine_id: str, workspace_port: int) -> dict[str, Any]:
    return {
        "machine_id": machine_id,
        "flavor": WORKSPACE_FLAVOR,
        "hostname": platform.node(),
        "os": platform.system(),
        # The hub talks to the box's OWN app on this port (`flow` instances differ).
        "workspace_port": workspace_port,
    }


async def create_node(machine_id: str, name: str, workspace_port: int) -> dict[str, Any]:
    from flow_sdk.cloud_client.transport.hub_http import hub_post
    from flow_sdk.config import ComputeProviderType
    from flow_sdk.schema.types import EntityType

    payload = {
        "name": name,
        "node_provider": ComputeProviderType.USER_MACHINE.value,
        "node_config": _node_config(machine_id, workspace_port),
    }
    created = await hub_post(EntityType.COMPUTE_NODE, payload)
    if not created or not created.get("id"):
        raise RuntimeError("hub did not return the created compute node")
    return created


async def setup_node(node_id: str) -> str:
    """``ops/setup`` pins ``node_provider_id`` to this machine id. Idempotent."""
    from flow_sdk.cloud_client.transport.hub_http import hub_post
    from flow_sdk.schema.types import EntityType

    result = await hub_post(EntityType.COMPUTE_NODE, {}, node_id, action="ops", sub_path="setup")
    return str(result) if result is not None else ""


async def _refresh_node_config(node: dict[str, Any], machine_id: str, workspace_port: int) -> dict[str, Any]:
    """Re-stamp this machine's facts (port, hostname) on a reused node when they moved."""
    from flow_sdk.cloud_client.transport.hub_http import hub_put
    from flow_sdk.schema.types import EntityType

    current = dict(node.get("node_config") or {})
    wanted = {**current, **_node_config(machine_id, workspace_port)}
    if wanted == current:
        return node
    updated = await hub_put(EntityType.COMPUTE_NODE, str(node["id"]), {"node_config": wanted})
    return updated or {**node, "node_config": wanted}


async def ensure_node(machine_id: str, name: str | None, workspace_port: int) -> tuple[dict[str, Any], bool]:
    """Return ``(node, created)`` — the node for this machine, set up on the hub."""
    node = await find_existing_node(machine_id)
    created = False
    if node is None:
        node = await create_node(machine_id, name or _default_node_name(), workspace_port)
        created = True
    else:
        node = await _refresh_node_config(node, machine_id, workspace_port)
    if node.get("node_provider_id") != machine_id:
        await setup_node(str(node["id"]))
    return node, created


def _current_hub_api_key() -> str | None:
    """This machine's usable hub key, or None when it must enroll with a code."""
    from flow_sdk.cli.auth.hub_login import resolve_hub_api_key

    return resolve_hub_api_key(require_live=True)


def _enroll_with_code(
    api_base_url: str, machine_id: str, workspace_port: int, code_file: Path | None = None
) -> tuple[str, str]:
    """Not logged in: device-code enrollment. Returns ``(api_key, node_id)`` once a human approved.

    ``code_file`` (set by ``flow connect --docker`` for the in-container run) receives
    the human-facing code so the host CLI can approve it or show it — never the
    ``device_code``, which stays in this process.
    """
    from flow_sdk.cli.auth.device_enroll import (
        EnrollmentDenied,
        enrollment_banner,
        finalize_grant,
        poll_for_grant,
        start_enrollment,
    )

    async def _run() -> tuple[str, str]:
        start = await start_enrollment(machine_id=machine_id, workspace_port=workspace_port)
        if code_file is not None:
            write_marker(
                code_file,
                {
                    "user_code": start.user_code,
                    "verification_uri": start.verification_uri,
                    "verification_uri_complete": start.verification_uri_complete,
                    "expires_in": start.expires_in,
                },
            )
        typer.echo(
            enrollment_banner(
                api_base_url,
                user_code=start.user_code,
                verification_uri=start.verification_uri,
                verification_uri_complete=start.verification_uri_complete,
                expires_in=start.expires_in,
            )
        )
        grant = await poll_for_grant(start)
        user = await finalize_grant(grant)
        typer.echo(
            f"Approved. Signed in as {user.get('email') or user.get('id')}; node {grant.node_name} ({grant.node_id})."
        )
        return grant.api_key, grant.node_id

    try:
        return asyncio.run(_run())
    except EnrollmentDenied as exc:
        typer.echo(f"Not enrolled: {exc}", err=True)
        raise typer.Exit(1)
    except KeyboardInterrupt:
        typer.echo("\nEnrollment cancelled.")
        raise typer.Exit(130)


def connect(
    name: Optional[str] = typer.Option(None, "--name", help="Name for this machine's compute node (first time only)"),
    docker: Optional[str] = typer.Option(
        None, "--docker", metavar="CONTAINER", help="Enroll a running Docker container instead of this machine"
    ),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Show worker logs"),
    code_file: Optional[Path] = typer.Option(None, "--code-file", hidden=True),
    ready_file: Optional[Path] = typer.Option(None, "--ready-file", hidden=True),
) -> None:
    """Connect THIS machine (or a Docker container) to the hub as a compute node.

    Logged in (`flow auth login`): the node is created on the hub right away.
    Not logged in: a short code is shown; approve it from any logged-in hub
    browser and the hub creates the node and signs this machine in.

    `--docker <container>` installs flow into a running container and runs
    `flow connect` inside it; a logged-in host approves the container's code
    itself, otherwise the code is shown for you to approve.

    Does not start the local Flow server: the hub initializes the workspace app
    on first use, exactly as it does for a cloud sandbox.
    """
    logging.basicConfig(
        level=logging.INFO if verbose else logging.WARNING, format="%(levelname)s %(name)s: %(message)s"
    )
    from flow_sdk.cloud_client.client import ApiConfig
    from flow_sdk.instance_settings import get_instance_settings

    api_base_url = ApiConfig.from_env().api_base_url
    if not api_base_url:
        typer.echo("No hub configured (FLOWPAD_HUB_URL). Run `flow config` or set the hub URL.", err=True)
        raise typer.Exit(1)

    if docker:
        if code_file or ready_file:
            typer.echo("--code-file/--ready-file are for the in-container run, not with --docker.", err=True)
            raise typer.Exit(2)
        _connect_docker(docker, name, api_base_url)
        return

    machine_id = _machine_id()
    port = get_instance_settings().port
    typer.echo(f"Hub:      {api_base_url}")
    typer.echo(f"Machine:  {platform.node()} ({machine_id[:12]}…)")

    api_key = _current_hub_api_key()
    if api_key:
        try:
            node, created = asyncio.run(ensure_node(machine_id, name, port))
        except Exception as exc:  # noqa: BLE001 — surface the hub's reason and stop
            typer.echo(f"ERROR: could not register this machine on the hub: {exc}", err=True)
            raise typer.Exit(1)
        node_id = str(node["id"])
        typer.echo(f"Node:     {node.get('name')} ({node_id}) {'created' if created else 'reused'}")
    else:
        api_key, node_id = _enroll_with_code(api_base_url, machine_id, port, code_file=code_file)

    from flow_sdk.compute.user_machine import WorkerAuthRejected, run_worker

    def on_connected() -> None:
        typer.echo("Connected. This machine is now serving the hub — press Ctrl-C to disconnect.")
        if ready_file is not None:
            write_marker(
                ready_file,
                {"node_id": node_id, "node_name": name or "", "hub_url": api_base_url, "connected_at": time.time()},
            )

    try:
        asyncio.run(
            run_worker(
                node_id=node_id,
                machine_id=machine_id,
                api_base_url=api_base_url,
                api_key=api_key,
                on_connected=on_connected,
            )
        )
    except WorkerAuthRejected as exc:
        typer.echo(f"ERROR: {exc}", err=True)
        raise typer.Exit(1)
    except KeyboardInterrupt:
        typer.echo("\nDisconnected.")


def _connect_docker(container: str, name: Optional[str], api_base_url: str) -> None:
    """Enroll a running Docker container as a hub machine; the worker keeps running inside it."""
    from flow_sdk.cli.auth.device_enroll import enrollment_banner
    from flow_sdk.cli.commands._docker_enroll import (
        LOG_FILE,
        Docker,
        DockerEnrollError,
        approve_container_code,
        container_env,
        default_node_name,
        find_install_script,
        find_wheel,
        hub_origin,
    )

    node_name = (name or "").strip() or default_node_name(container)
    try:
        dock = Docker.for_container(container)
        dock.ensure_running()
        wheel = find_wheel()
        if not wheel:
            raise DockerEnrollError("could not find a flowpad wheel; run `uv build --wheel --out-dir dist/` first")
        script = find_install_script()
        if not script:
            raise DockerEnrollError("install_flow_on_docker.sh not found next to the flow_sdk package")
        typer.echo(f"Installing flow into {container} from {Path(wheel).name}…")
        summary = dock.install_flow(wheel, script)
        if summary:
            typer.echo(f"  {summary.splitlines()[-1]}")
        if not dock.prepare(container_env(hub_origin())):
            typer.echo(
                "  warning: host.docker.internal does not resolve in the container — on Linux start it with "
                "--add-host=host.docker.internal:host-gateway",
                err=True,
            )
        dock.start_connect(node_name)
    except DockerEnrollError as exc:
        typer.echo(f"ERROR: {exc}", err=True)
        raise typer.Exit(1)

    # Either the container was already signed in (ready straight away) or it minted a code.
    code = ready = None
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline and code is None and ready is None:
        ready, code = dock.read_markers()
        if code is None and ready is None:
            time.sleep(1)
    if code is None and ready is None:
        typer.echo(f"ERROR: flow connect did not start inside {container}:\n{dock.log_tail()}", err=True)
        raise typer.Exit(1)

    approved = False
    expires_in = int((code or {}).get("expires_in", 900))
    if code is not None:
        api_key = _current_hub_api_key()
        if api_key:
            typer.echo(f"Approving {container} as {node_name} with this machine's hub login…")
            try:
                result = asyncio.run(approve_container_code(code["user_code"], node_name))
            except Exception as exc:  # noqa: BLE001 — the hub's reason is the useful part
                typer.echo(f"ERROR: could not approve the container: {exc}", err=True)
                raise typer.Exit(1)
            machine = result.get("machine") or {}
            typer.echo(
                f"  approved: {machine.get('hostname', '?')} ({machine.get('os_type', '?')}) → {result.get('node_id')}"
            )
            approved = True
        else:
            typer.echo(f"This host is not logged in to the hub, so approve {container} yourself:")
            typer.echo(enrollment_banner(api_base_url, **code))

    wait_for = expires_in if code else 60
    deadline = time.monotonic() + wait_for
    try:
        while ready is None and time.monotonic() < deadline:
            time.sleep(2)
            ready, _ = dock.read_markers()
    except KeyboardInterrupt:
        if not approved:
            dock.kill_ghosts()
            typer.echo("\nCancelled; nothing was enrolled.")
            raise typer.Exit(130)
        typer.echo("\nLeaving the container to finish connecting on its own.")
        raise typer.Exit(0)
    if ready is None:
        typer.echo(f"ERROR: the container never attached:\n{dock.log_tail()}", err=True)
        raise typer.Exit(1)
    typer.echo(f"Connected: {node_name} ({ready.get('node_id')}) is serving the hub from container {container}.")
    typer.echo(f"  logs:   docker exec {container} tail -f {LOG_FILE}")
    typer.echo(f"  re-run: flow connect --docker {container}")
