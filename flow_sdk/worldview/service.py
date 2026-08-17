"""Public headless service API for loading, syncing, and linking WorldView."""

from __future__ import annotations

from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.builtin.artifact import Artifact
from flow_sdk.builtin.deployment import Deployment
from flow_sdk.worldview.graph import build_worldview
from flow_sdk.worldview.models import ArtifactLinkSource, WorldViewGraph
from flow_sdk.worldview.providers.base import InventoryProvider, InventoryProviderError
from flow_sdk.worldview.providers.gcp import GCPInventoryProvider
from flow_sdk.worldview.reconcile import reconcile_provider_error, reconcile_snapshot


class WorldViewServiceError(ValueError):
    pass


async def sync_worldview(provider: InventoryProvider | None = None) -> WorldViewGraph:
    """Run one explicit read-only inventory and return its fresh projection."""

    inventory_provider = provider or GCPInventoryProvider()
    try:
        snapshot = await inventory_provider.collect()
    except InventoryProviderError as exc:
        report = reconcile_provider_error(inventory_provider.name, str(exc))
    else:
        report = await reconcile_snapshot(snapshot)
    return await build_worldview(sync_report=report)


async def link_artifact(deployment_id: str, artifact_id: str) -> Deployment:
    """Persist an explicit local Artifact mapping for one Deployment."""

    if not is_valid_entity_id(deployment_id):
        raise WorldViewServiceError("deployment_id must be a UUID v4 or v5")
    if not is_valid_entity_id(artifact_id):
        raise WorldViewServiceError("artifact_id must be a UUID v4 or v5")
    deployment = await Deployment.get_by_id(deployment_id)
    if deployment is None:
        raise WorldViewServiceError("Deployment not found")
    artifact = await Artifact.get_by_id(artifact_id)
    if artifact is None:
        raise WorldViewServiceError("Artifact not found")
    deployment.artifact_id = artifact.id
    deployment.artifact_link_source = ArtifactLinkSource.MANUAL
    await deployment.save()
    return deployment


__all__ = ["WorldViewServiceError", "build_worldview", "link_artifact", "sync_worldview"]
