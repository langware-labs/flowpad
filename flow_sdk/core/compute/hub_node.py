"""This machine as a hub ComputeNode (``node_provider=user_machine``, keyed by its stable machine id).

Shared by ``flow connect`` (the CLI, which then serves the node over a worker socket) and by the backend's
Remote control setup (which only registers the node). Two lookups, on purpose:

* :func:`ensure_node` — the CLI's: a lookup the hub could not answer reads as "no node yet".
* :func:`ensure_node_strict` — the backend's: any hub error on the lookup raises, so a network blip can never
  create a second node for the same machine.
"""

from __future__ import annotations

import platform
import uuid
from pathlib import Path
from typing import Any, Optional, Protocol

WORKSPACE_FLAVOR = "workspace"

MACHINE_ID_FILE = Path.home() / ".flow" / "machine_id"


class HubCalls(Protocol):
    """What these functions need of the hub: ``HubProxy.call``'s shape (raises ``HubError`` on any failure)."""

    async def call(
        self,
        method: str,
        entity_type: Any,
        entity_id: str | None = None,
        action: str | None = None,
        sub_path: str | None = None,
        *,
        payload: Any = None,
    ) -> Any: ...


def _hub(hub: HubCalls | None) -> HubCalls:
    if hub is not None:
        return hub
    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415

    return HubProxy


def machine_id() -> str:
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


def default_node_name() -> str:
    return f"@{platform.node().split('.')[0] or 'my-machine'}"


def _node_matches(node: dict[str, Any], machine_id: str) -> bool:
    from flow_sdk.config import ComputeProviderType

    if node.get("node_provider") != ComputeProviderType.USER_MACHINE.value:
        return False
    config = node.get("node_config") or {}
    return isinstance(config, dict) and config.get("machine_id") == machine_id


def _matching_node(nodes: Any, machine_id: str) -> Optional[dict[str, Any]]:
    if not isinstance(nodes, list):
        return None
    for node in nodes:
        if isinstance(node, dict) and _node_matches(node, machine_id):
            return node
    return None


async def find_existing_node(machine_id: str) -> Optional[dict[str, Any]]:
    """The hub ComputeNode already standing for this machine, if any."""
    from flow_sdk.cloud_client.hub_proxy import HubProxy
    from flow_sdk.schema.types import EntityType

    return _matching_node(await HubProxy.try_call("GET", EntityType.COMPUTE_NODE), machine_id)


def _node_config(machine_id: str, workspace_port: int) -> dict[str, Any]:
    return {
        "machine_id": machine_id,
        "flavor": WORKSPACE_FLAVOR,
        "hostname": platform.node(),
        "os": platform.system(),
        # The hub talks to the box's OWN app on this port (`flow` instances differ).
        "workspace_port": workspace_port,
    }


async def create_node(
    machine_id: str, name: str, workspace_port: int, *, hub: HubCalls | None = None
) -> dict[str, Any]:
    from flow_sdk.config import ComputeProviderType
    from flow_sdk.schema.types import EntityType

    payload = {
        "name": name,
        "node_provider": ComputeProviderType.USER_MACHINE.value,
        "node_config": _node_config(machine_id, workspace_port),
    }
    created = await _hub(hub).call("POST", EntityType.COMPUTE_NODE, payload=payload)
    if not created or not created.get("id"):
        raise RuntimeError("hub did not return the created compute node")
    return created


async def setup_node(node_id: str, *, hub: HubCalls | None = None) -> str:
    """``ops/setup`` pins ``node_provider_id`` to the node's own id. Idempotent."""
    from flow_sdk.schema.types import EntityType

    result = await _hub(hub).call("POST", EntityType.COMPUTE_NODE, node_id, "ops", "setup", payload={})
    return str(result) if result is not None else ""


async def _refresh_node_config(node: dict[str, Any], machine_id: str, workspace_port: int) -> dict[str, Any]:
    """Re-stamp this machine's facts (port, hostname) on a reused node when they moved."""
    from flow_sdk.cloud_client.hub_proxy import HubProxy
    from flow_sdk.schema.types import EntityType

    current = dict(node.get("node_config") or {})
    wanted = {**current, **_node_config(machine_id, workspace_port)}
    if wanted == current:
        return node
    updated = await HubProxy.call("PUT", EntityType.COMPUTE_NODE, str(node["id"]), payload={"node_config": wanted})
    return updated or {**node, "node_config": wanted}


async def ensure_node(machine_id: str, name: str | None, workspace_port: int) -> tuple[dict[str, Any], bool]:
    """Return ``(node, created)`` — the node for this machine, set up on the hub."""
    node = await find_existing_node(machine_id)
    created = False
    if node is None:
        node = await create_node(machine_id, name or default_node_name(), workspace_port)
        created = True
    else:
        node = await _refresh_node_config(node, machine_id, workspace_port)
    if not node_is_set_up(node):
        await setup_node(str(node["id"]))
    return node, created


async def ensure_node_strict(machine_id: str, workspace_port: int, *, hub: HubCalls | None = None) -> dict[str, Any]:
    """:func:`ensure_node` for the backend: the lookup RAISES when the hub could not answer it. Answers the node.

    Nothing is created unless the hub itself listed this account's nodes and none is this machine's. A reused
    node keeps its config: registering for Remote control runs no worker, so it has no port to re-stamp — and it
    must not move the port of a node a real ``flow connect`` is serving from another instance.
    """
    from flow_sdk.schema.types import EntityType

    hub = _hub(hub)
    nodes = await hub.call("GET", EntityType.COMPUTE_NODE)
    if nodes == {}:
        # WORKAROUND: ``_unwrap`` in ``flow_sdk/cloud_client/hub_proxy.py`` returns ``body.get("data") or {}``, so
        # the empty list of an account with no node yet arrives as ``{}``. The root fix belongs there (it has many
        # callers) and is a follow-up. A failed lookup never gets here: ``call`` raises.
        nodes = []
    if not isinstance(nodes, list):
        raise RuntimeError("hub did not answer a list of compute nodes")
    node = _matching_node(nodes, machine_id)
    if node is None:
        node = await create_node(machine_id, default_node_name(), workspace_port, hub=hub)
    if not node_is_set_up(node):
        await setup_node(str(node["id"]), hub=hub)
    return node


def node_is_set_up(node: dict[str, Any]) -> bool:
    """The hub's own test: ``ops/setup`` pins ``node_provider_id`` to the node's id.

    Comparing it to the machine id instead made every re-run call ``ops/setup``
    again — which a device-enrolled machine's key may not (403 ``owner_by_api``),
    so a machine enrolled with a code could never reconnect.
    """
    return bool(node.get("id")) and node.get("node_provider_id") == node.get("id")
