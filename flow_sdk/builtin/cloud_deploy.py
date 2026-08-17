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

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.core import Entity


async def deploy_entity_to_cloud(entity: "Entity") -> dict[str, Any]:
    """POST ``<entity>/deploy`` on the hub and adopt the placement it returns.

    Deliberately takes no node and no principal. Were either passable from here
    they would be passable from anywhere, which is the exact hole the hub's
    pentest guards exist to keep shut. This call says only *which entity*.
    """
    from flow_sdk.builtin.deployment import Deployment  # noqa: PLC0415
    from flow_sdk.cli.auth.credentials import load_credentials  # noqa: PLC0415
    from flow_sdk.cloud_client.client import ApiConfig, FlowpadClient  # noqa: PLC0415
    from flow_sdk.core.urls.service_urls import build_hub_url  # noqa: PLC0415

    creds = load_credentials()
    if not creds or not creds.api_key:
        raise RuntimeError("Cloud login required before deploy")

    path = build_hub_url(entity, action="deploy")
    async with FlowpadClient(ApiConfig.from_env(), api_key=creds.api_key) as client:
        # `post` already unwraps the envelope, and raises on a non-success one —
        # so a hub-side refusal surfaces here rather than returning {}.
        data = await client.post(path, {})
    data = data if isinstance(data, dict) else {}
    await Deployment.adopt_from_hub(data.get("deployment"), element=entity)
    return data


__all__ = ["deploy_entity_to_cloud"]
