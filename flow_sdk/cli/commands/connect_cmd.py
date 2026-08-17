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
import uuid
from pathlib import Path
from typing import Any, Optional

import typer

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


def _require_hub_api_key() -> str:
    """The key every other hub call would carry (``cloud_api_key`` setting, else the file login)."""
    from flow_sdk.cli.auth.credentials import load_credentials
    from flow_sdk.cli.auth.hub_login import resolve_hub_api_key
    from flow_sdk.cloud_client.constants import EXPIRY_LEEWAY_SECONDS

    api_key = resolve_hub_api_key()
    if not api_key:
        typer.echo("Not logged in to the hub. Run `flow auth login` first.", err=True)
        raise typer.Exit(1)
    creds = load_credentials()
    if creds is not None and creds.api_key == api_key and creds.is_expired(EXPIRY_LEEWAY_SECONDS):
        typer.echo("Hub login has expired. Run `flow auth login` again.", err=True)
        raise typer.Exit(1)
    return api_key


def connect(
    name: Optional[str] = typer.Option(None, "--name", help="Name for this machine's compute node (first time only)"),
    no_server: bool = typer.Option(False, "--no-server", help="Do not start the local Flow server"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Show worker logs"),
) -> None:
    """Connect THIS machine to the hub as a compute node (Ctrl-C to disconnect)."""
    logging.basicConfig(
        level=logging.INFO if verbose else logging.WARNING, format="%(levelname)s %(name)s: %(message)s"
    )

    api_key = _require_hub_api_key()
    from flow_sdk.cloud_client.client import ApiConfig

    api_base_url = ApiConfig.from_env().api_base_url
    if not api_base_url:
        typer.echo("No hub configured (FLOWPAD_HUB_URL). Run `flow config` or set the hub URL.", err=True)
        raise typer.Exit(1)

    from flow_sdk.instance_settings import get_instance_settings

    machine_id = _machine_id()
    port = get_instance_settings().port
    typer.echo(f"Hub:      {api_base_url}")
    typer.echo(f"Machine:  {platform.node()} ({machine_id[:12]}…)")

    try:
        node, created = asyncio.run(ensure_node(machine_id, name, port))
    except Exception as exc:  # noqa: BLE001 — surface the hub's reason and stop
        typer.echo(f"ERROR: could not register this machine on the hub: {exc}", err=True)
        raise typer.Exit(1)
    node_id = str(node["id"])
    typer.echo(f"Node:     {node.get('name')} ({node_id}) {'created' if created else 'reused'}")

    if not no_server:
        from flow_sdk.cli.flow_cli import _start_service

        _start_service(port)
        typer.echo(f"Server:   http://127.0.0.1:{port} (headless)")

    from flow_sdk.compute.user_machine import WorkerAuthRejected, run_worker

    def on_connected() -> None:
        typer.echo("Connected. This machine is now serving the hub — press Ctrl-C to disconnect.")

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
