"""Asking the hub to place something on a machine of its own.

One helper, because "deploy X to the cloud" is the same three steps whatever X
is: prove we are logged in, POST ``<entity>/deploy`` on the hub, and adopt the
``Deployment`` row it hands back at the hub's id.

What differs per entity is only how it gets PUBLISHED first (an Agent commits
and registers its asset through Git; a Project shares itself as a unit), so that
step stays with the entity and is done before calling in here. Deliberately not
a `publish` hook on this function: a hook that dispatches on type is how one
seam becomes two.

The credentials live in this process, so the browser never talks to the hub
directly.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.core import Entity


#: A cloud placement's credential environment when the caller names none.
DEFAULT_CLOUD_ENVIRONMENT = "production"

#: The hub compute provider a cloud placement lands on when the caller names none. Which providers
#: exist is the hub's to say: it refuses one it does not offer.
DEFAULT_CLOUD_PROVIDER = "e2b"

#: How long a deploy whose answer was lost waits for the hub to push its machine. The load balancer in front of
#: the hub drops a request it has held for minutes while the hub goes on placing the machine: a dropped answer is
#: not a failure.
PLACED_WITHIN_S = 8 * 60
#: How often the local row is looked at meanwhile: a read of this computer's own store.
PLACED_LOCAL_POLL_S = 1


async def deploy_entity_to_cloud(
    entity: "Entity",
    environment: str | None = None,
    *,
    provider: str | None = None,
    require: list[str] | None = None,
    deployment_id: str | None = None,
) -> dict[str, Any]:
    """POST ``<entity>/deploy`` on the hub and adopt the placement it returns.

    Deliberately takes no node and no principal. Were either passable from here
    they would be passable from anywhere, which is the exact hole the hub's
    pentest guards exist to keep shut. This call says only *which entity*, on which
    ``provider`` (the hub's name; none: :data:`DEFAULT_CLOUD_PROVIDER`), and
    which credential ``environment`` the placement reads (``production`` by
    default) — a name, never a value. ``require`` names the variables the hub must already hold for
    the placement; it refuses (``not_ready``) before paying for a machine otherwise. ``deployment_id`` names
    the placement this deploy is for (the one a plan made); without it the hub makes a new one.
    """
    from flow_sdk.builtin.deployment import Deployment  # noqa: PLC0415
    from flow_sdk.cli.auth.credentials import load_credentials  # noqa: PLC0415
    from flow_sdk.cloud_client.hub_proxy import DEPLOY_TIMEOUT, HubProxy  # noqa: PLC0415
    from flow_sdk.schema.data_spec.credential_contract import normalize_environment  # noqa: PLC0415

    environment = normalize_environment(environment or DEFAULT_CLOUD_ENVIRONMENT)
    creds = load_credentials()
    if not creds or not creds.api_key:
        raise RuntimeError("Cloud login required before deploy")

    # `strict` unwraps the envelope and raises on a refusing one —
    # so a hub-side refusal surfaces here rather than returning {}.
    body = {
        "environment": environment,
        "provider": provider or DEFAULT_CLOUD_PROVIDER,
        **({"require": require} if require else {}),
        **({"deployment_id": deployment_id} if deployment_id else {}),
    }
    data = await HubProxy.call(
        "POST", entity.type, entity.id, "deploy", payload=body, strict=True, timeout=DEPLOY_TIMEOUT
    )
    data = data if isinstance(data, dict) else {}
    await Deployment.adopt_from_hub(data.get("deployment"), element=entity)
    from flow_sdk.builtin.service_endpoint import ServiceEndpoint  # noqa: PLC0415

    # What the placement serves (its chat, its apps), held here at the hub's ids.
    for row in data.get("endpoints") or []:
        await ServiceEndpoint.adopt_from_hub(row)
    return data


async def wait_until_placed(deployment_id: str) -> None:
    """Wait for the placement's local row to have its machine — for a deploy whose answer never came back. The hub
    pushes the placement as it gives it its machine and the bridge mirrors each push into that row, so this only
    reads here, never asks the hub. Raises ``TimeoutError`` after :data:`PLACED_WITHIN_S` with none."""
    from flow_sdk.builtin.deployment import Deployment  # noqa: PLC0415

    async def placed() -> None:
        while True:
            row = await Deployment.get_by_id(deployment_id)
            if row is not None and row.origin and row.origin.external_id and row.status.provider_state == "running":
                return
            await asyncio.sleep(PLACED_LOCAL_POLL_S)

    try:
        await asyncio.wait_for(placed(), PLACED_WITHIN_S)
    except TimeoutError:
        raise TimeoutError(
            f"the hub sent no machine for it within {PLACED_WITHIN_S // 60} minutes of losing its answer"
        ) from None


__all__ = ["DEFAULT_CLOUD_PROVIDER", "deploy_entity_to_cloud", "wait_until_placed"]
