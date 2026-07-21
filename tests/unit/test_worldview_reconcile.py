from __future__ import annotations

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.artifact import Artifact
from flow_sdk.builtin.deployment import Deployment
from flow_sdk.worldview.graph import build_worldview
from flow_sdk.worldview.models import (
    DeploymentObservation,
    InventoryOrganization,
    InventoryResource,
    InventorySnapshot,
    OrganizationInventory,
)
from flow_sdk.worldview.reconcile import gcp_deployment_id, reconcile_snapshot
from flow_sdk.worldview.service import link_artifact


def _snapshot(org_id: str, resources: list[InventoryResource], *, error: str | None = None):
    return InventorySnapshot(
        provider="gcp",
        observed_at="2026-07-18T12:00:00Z",
        organizations=[
            OrganizationInventory(
                organization=InventoryOrganization(
                    id=org_id,
                    name=f"Org {org_id}",
                    full_resource_name=f"//cloudresourcemanager.googleapis.com/organizations/{org_id}",
                ),
                resources=resources,
                error=error,
            )
        ],
    )


@pytest.mark.asyncio
async def test_reconcile_is_idempotent_and_projects_links_and_hierarchy():
    org_id = "worldview-idempotent"
    artifact = Artifact(id=mint_uuid(), name="Web", kind="application.web")
    await artifact.save(notify=False)
    full_name = "//run.googleapis.com/projects/101/locations/us-central1/services/web-idempotent"
    resource = InventoryResource(
        full_resource_name=full_name,
        asset_type="run.googleapis.com/Service",
        name="web-idempotent",
        organization=f"organizations/{org_id}",
        project="projects/101",
        location="us-central1",
        labels={"flowpad_artifact_id": artifact.id},
        provider_state="ACTIVE",
    )

    first = await reconcile_snapshot(_snapshot(org_id, [resource]))
    second = await reconcile_snapshot(_snapshot(org_id, [resource]))
    deployment = await Deployment.get_by_id(gcp_deployment_id(full_name))
    assert first.created >= 3  # org, project, resource; the singleton root may pre-exist
    assert second.created == 0
    assert deployment is not None
    assert deployment.parent_type_id is not None
    assert deployment.artifact_id == artifact.id

    graph = await build_worldview()
    kinds = {edge.kind for edge in graph.edges}
    assert {"child", "deployed_as"}.issubset(kinds)
    assert graph.schema_version == 1
    assert graph.projection == "deployment"
    assert graph.root is not None
    assert {edge.kind: edge.topology for edge in graph.edges}["child"] == "hierarchy"
    assert {edge.kind: edge.topology for edge in graph.edges}["deployed_as"] == "association"
    assert graph.counts.model_dump() == {"nodes": len(graph.nodes), "edges": len(graph.edges)}


@pytest.mark.asyncio
async def test_manual_artifact_link_survives_later_provider_sync():
    org_id = "worldview-manual-link"
    provider_artifact = Artifact(id=mint_uuid(), name="Provider link", kind="application.web")
    manual_artifact = Artifact(id=mint_uuid(), name="Manual link", kind="application.web")
    await provider_artifact.save(notify=False)
    await manual_artifact.save(notify=False)
    full_name = "//run.googleapis.com/projects/303/locations/us-central1/services/manual-link"
    resource = InventoryResource(
        full_resource_name=full_name,
        asset_type="run.googleapis.com/Service",
        name="manual-link",
        organization=f"organizations/{org_id}",
        project="projects/303",
        labels={"flowpad_artifact_id": provider_artifact.id},
    )

    await reconcile_snapshot(_snapshot(org_id, [resource]))
    deployment_id = gcp_deployment_id(full_name)
    await link_artifact(deployment_id, manual_artifact.id)
    await reconcile_snapshot(_snapshot(org_id, [resource]))

    deployment = await Deployment.get_by_id(deployment_id)
    assert deployment is not None
    assert deployment.artifact_id == manual_artifact.id
    assert deployment.artifact_link_source == "manual"


@pytest.mark.asyncio
async def test_inventory_reconcile_preserves_provider_enrichment_observations():
    org_id = "worldview-observations"
    full_name = "//run.googleapis.com/projects/707/locations/us-central1/services/observed"
    initial = InventoryResource(
        full_resource_name=full_name,
        asset_type="run.googleapis.com/Service",
        name="observed",
        organization=f"organizations/{org_id}",
        project="projects/707",
        provider_state="ACTIVE",
    )
    await reconcile_snapshot(_snapshot(org_id, [initial]))
    deployment_id = gcp_deployment_id(full_name)
    deployment = await Deployment.get_by_id(deployment_id)
    assert deployment is not None
    deployment.observations = {
        "cost": DeploymentObservation(
            metric="cost.net",
            value=12.5,
            unit="USD",
            observed_at="2026-07-19T00:00:00Z",
            window_start="2026-06-19T00:00:00Z",
            window_end="2026-07-19T00:00:00Z",
            source="gcp.billing.detailed_export",
        )
    }
    await deployment.save(notify=False)

    changed_inventory = initial.model_copy(update={"provider_state": "INACTIVE"})
    await reconcile_snapshot(_snapshot(org_id, [changed_inventory]))

    preserved = await Deployment.get_by_id(deployment_id)
    assert preserved is not None
    assert preserved.status.provider_state == "INACTIVE"
    assert preserved.observations["cost"].value == 12.5
    graph = await build_worldview()
    projected = next(node for node in graph.nodes if node.id == deployment_id)
    assert projected.properties["observations"]["cost"]["unit"] == "USD"


@pytest.mark.asyncio
async def test_invalid_provider_artifact_label_is_ignored():
    org_id = "worldview-invalid-label"
    full_name = "//run.googleapis.com/projects/404/locations/us-central1/services/invalid-label"
    resource = InventoryResource(
        full_resource_name=full_name,
        asset_type="run.googleapis.com/Service",
        name="invalid-label",
        organization=f"organizations/{org_id}",
        project="projects/404",
        labels={"flowpad_artifact_id": "not-an-entity-id"},
    )

    report = await reconcile_snapshot(_snapshot(org_id, [resource]))
    deployment = await Deployment.get_by_id(gcp_deployment_id(full_name))
    assert deployment is not None
    assert deployment.artifact_id is None
    assert any("ignored invalid flowpad_artifact_id label" in item for item in report.warnings)


@pytest.mark.asyncio
async def test_reconcile_marks_unseen_stale_but_preserves_failed_org_rows():
    org_id = "worldview-stale"
    full_name = "//sqladmin.googleapis.com/projects/202/instances/db-stale"
    resource = InventoryResource(
        full_resource_name=full_name,
        asset_type="sqladmin.googleapis.com/Instance",
        name="db-stale",
        organization=f"organizations/{org_id}",
        project="projects/202",
    )
    await reconcile_snapshot(_snapshot(org_id, [resource]))
    stale_report = await reconcile_snapshot(_snapshot(org_id, []))
    deployment = await Deployment.get_by_id(gcp_deployment_id(full_name))
    assert stale_report.stale >= 1
    assert deployment is not None and deployment.status.sync_state == "stale"

    await reconcile_snapshot(_snapshot(org_id, [resource]))
    failed = await reconcile_snapshot(_snapshot(org_id, [], error="permission denied"))
    preserved = await Deployment.get_by_id(gcp_deployment_id(full_name))
    assert failed.organizations_failed == 1
    assert preserved is not None and preserved.status.sync_state == "current"


@pytest.mark.asyncio
async def test_partial_multi_org_sync_continues_and_preserves_failed_scope():
    failed_org_id = "worldview-partial-failed"
    preserved_name = "//sqladmin.googleapis.com/projects/505/instances/preserved"
    preserved_resource = InventoryResource(
        full_resource_name=preserved_name,
        asset_type="sqladmin.googleapis.com/Instance",
        name="preserved",
        organization=f"organizations/{failed_org_id}",
        project="projects/505",
    )
    await reconcile_snapshot(_snapshot(failed_org_id, [preserved_resource]))

    success_org_id = "worldview-partial-success"
    success_name = "//run.googleapis.com/projects/606/locations/us-central1/services/current"
    snapshot = InventorySnapshot(
        provider="gcp",
        observed_at="2026-07-18T12:30:00Z",
        organizations=[
            OrganizationInventory(
                organization=InventoryOrganization(
                    id=success_org_id,
                    name="Success org",
                    full_resource_name=(f"//cloudresourcemanager.googleapis.com/organizations/{success_org_id}"),
                ),
                resources=[
                    InventoryResource(
                        full_resource_name=success_name,
                        asset_type="run.googleapis.com/Service",
                        name="current",
                        organization=f"organizations/{success_org_id}",
                        project="projects/606",
                    )
                ],
            ),
            OrganizationInventory(
                organization=InventoryOrganization(
                    id=failed_org_id,
                    name="Failed org",
                    full_resource_name=(f"//cloudresourcemanager.googleapis.com/organizations/{failed_org_id}"),
                ),
                error="permission denied",
            ),
        ],
    )

    report = await reconcile_snapshot(snapshot)
    current = await Deployment.get_by_id(gcp_deployment_id(success_name))
    preserved = await Deployment.get_by_id(gcp_deployment_id(preserved_name))
    assert report.state == "partial"
    assert report.organizations_succeeded == 1
    assert report.organizations_failed == 1
    assert current is not None and current.status.sync_state == "current"
    assert preserved is not None and preserved.status.sync_state == "current"


@pytest.mark.asyncio
async def test_organization_asset_never_becomes_its_own_parent():
    org_id = "worldview-org-self-edge"
    full_name = f"//cloudresourcemanager.googleapis.com/organizations/{org_id}"
    org_asset = InventoryResource(
        full_resource_name=full_name,
        asset_type="cloudresourcemanager.googleapis.com/Organization",
        name="Observed organization",
        organization=f"organizations/{org_id}",
    )

    await reconcile_snapshot(_snapshot(org_id, [org_asset]))
    organization = await Deployment.get_by_id(gcp_deployment_id(full_name))
    assert organization is not None
    assert organization.parent_type_id != str(organization.typeid)

    graph = await build_worldview()
    assert all(
        not (edge.kind == "child" and edge.from_.type == edge.to.type and edge.from_.id == edge.to.id)
        for edge in graph.edges
    )
