"""Idempotent provider-inventory materialization into Deployment entities."""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from flow_sdk.api.api_types.identifier import is_valid_entity_id, mint_uuid
from flow_sdk.api.type_id import TypeId
from flow_sdk.builtin.deployment import Deployment
from flow_sdk.worldview.models import (
    ArtifactLinkSource,
    DeploymentStatus,
    DeploymentSyncState,
    DeploymentTarget,
    ExternalResourceRef,
    InventoryOrganization,
    InventoryResource,
    InventorySnapshot,
    WorldViewSyncReport,
    utc_now_iso,
)
from flow_sdk.worldview.providers.gcp import GCP_ARTIFACT_LABEL, gcp_kind_from_asset_type

WORLDVIEW_ROOT_KEY = "deployment:gcp:worldview"
WORLDVIEW_ROOT_ID = mint_uuid(WORLDVIEW_ROOT_KEY, namespace=uuid.NAMESPACE_URL)
_SYNC_LABEL_PREFIX = "flowpad.worldview.sync."


@dataclass
class _Plan:
    deployment: Deployment
    parent_full_resource_name: str | None
    fallback_parent_full_resource_name: str | None = None


def gcp_deployment_id(full_resource_name: str) -> str:
    return mint_uuid(
        f"deployment:gcp:{full_resource_name}",
        namespace=uuid.NAMESPACE_URL,
    )


def _typeid(deployment_id: str) -> str:
    return str(TypeId(type="deployment", id=deployment_id))


def _scope_full_name(scope: str) -> str:
    return f"//cloudresourcemanager.googleapis.com/{scope.strip('/')}"


def _scope_asset_type(scope: str) -> str:
    prefix = scope.split("/", 1)[0]
    kind = {"organizations": "Organization", "folders": "Folder", "projects": "Project"}.get(
        prefix,
        "Resource",
    )
    return f"cloudresourcemanager.googleapis.com/{kind}"


def _scope_name(scope: str) -> str:
    singular = scope.split("/", 1)[0].rstrip("s").title()
    return f"{singular} {scope.rsplit('/', 1)[-1]}"


def _resource_ref(resource: InventoryResource) -> ExternalResourceRef:
    return ExternalResourceRef(
        full_resource_name=resource.full_resource_name,
        asset_type=resource.asset_type,
        parent_full_resource_name=resource.parent_full_resource_name,
        provider_uid=resource.provider_uid,
    )


def _organization_resource(organization: InventoryOrganization) -> InventoryResource:
    return InventoryResource(
        full_resource_name=organization.full_resource_name,
        asset_type="cloudresourcemanager.googleapis.com/Organization",
        name=organization.name,
        organization=f"organizations/{organization.id}",
        provider_uid=organization.id,
    )


def _deployment_for_resource(
    resource: InventoryResource,
    *,
    organization_scope: str,
    observed_at: str,
    warnings: list[str],
) -> Deployment:
    artifact_id: str | None = None
    artifact_link_source: ArtifactLinkSource | None = None
    label_id = resource.labels.get(GCP_ARTIFACT_LABEL)
    if label_id:
        if is_valid_entity_id(label_id):
            artifact_id = label_id
            artifact_link_source = ArtifactLinkSource.GCP_LABEL
        else:
            warnings.append(f"{resource.full_resource_name}: ignored invalid {GCP_ARTIFACT_LABEL} label")
    return Deployment(
        id=gcp_deployment_id(resource.full_resource_name),
        name=resource.name,
        kind=gcp_kind_from_asset_type(resource.asset_type),
        artifact_id=artifact_id,
        artifact_link_source=artifact_link_source,
        target=DeploymentTarget(
            provider="gcp",
            scope=organization_scope,
            location=resource.location,
        ),
        resource=_resource_ref(resource),
        status=DeploymentStatus(
            sync_state=DeploymentSyncState.CURRENT,
            provider_state=resource.provider_state,
            observed_at=observed_at,
        ),
        provider_labels=resource.labels,
        source_revision=resource.source_revision,
    )


def _sync_labels(report: WorldViewSyncReport) -> dict[str, str]:
    return {
        f"{_SYNC_LABEL_PREFIX}organizations_total": str(report.organizations_total),
        f"{_SYNC_LABEL_PREFIX}organizations_succeeded": str(report.organizations_succeeded),
        f"{_SYNC_LABEL_PREFIX}organizations_failed": str(report.organizations_failed),
        f"{_SYNC_LABEL_PREFIX}resources_seen": str(report.resources_seen),
        f"{_SYNC_LABEL_PREFIX}stale": str(report.stale),
    }


def _root_deployment(report: WorldViewSyncReport) -> Deployment:
    message = None
    if report.organizations_failed:
        message = f"{report.organizations_failed} of {report.organizations_total} organization inventories failed"
    return Deployment(
        id=WORLDVIEW_ROOT_ID,
        name="Google Cloud",
        kind="gcp.worldview",
        target=DeploymentTarget(provider="gcp", scope="organizations"),
        status=DeploymentStatus(
            sync_state=report.state,
            observed_at=report.observed_at,
            message=message,
        ),
        provider_labels=_sync_labels(report),
    )


def _add_scope(
    plans: dict[str, _Plan],
    scope: str,
    *,
    organization_scope: str,
    observed_at: str,
    parent_full_resource_name: str | None,
    warnings: list[str],
) -> str:
    full_name = _scope_full_name(scope)
    if full_name not in plans:
        resource = InventoryResource(
            full_resource_name=full_name,
            asset_type=_scope_asset_type(scope),
            name=_scope_name(scope),
            organization=organization_scope,
            provider_uid=scope.rsplit("/", 1)[-1],
        )
        plans[full_name] = _Plan(
            deployment=_deployment_for_resource(
                resource,
                organization_scope=organization_scope,
                observed_at=observed_at,
                warnings=warnings,
            ),
            parent_full_resource_name=parent_full_resource_name,
            fallback_parent_full_resource_name=parent_full_resource_name,
        )
    return full_name


def _plans_for_snapshot(
    snapshot: InventorySnapshot,
    report: WorldViewSyncReport,
) -> tuple[dict[str, _Plan], set[str]]:
    plans: dict[str, _Plan] = {}
    failed_scopes: set[str] = set()

    for result in snapshot.organizations:
        organization = result.organization
        organization_scope = f"organizations/{organization.id}"
        org_resource = _organization_resource(organization)
        org_deployment = _deployment_for_resource(
            org_resource,
            organization_scope=organization_scope,
            observed_at=snapshot.observed_at,
            warnings=report.warnings,
        )
        if result.error:
            failed_scopes.add(organization_scope)
            org_deployment.status = DeploymentStatus(
                sync_state=DeploymentSyncState.ERROR,
                observed_at=snapshot.observed_at,
                message=result.error,
            )
            report.warnings.append(f"{organization_scope}: {result.error}")
        plans[organization.full_resource_name] = _Plan(
            deployment=org_deployment,
            parent_full_resource_name=None,
            fallback_parent_full_resource_name=None,
        )
        if result.error:
            continue

        for resource in result.resources:
            # CAI may include the organization asset inside its own scoped
            # search. Merge its observed fields into the already-planned org
            # node while retaining the WorldView root as its parent; treating
            # the organization as its own deepest scope would create a
            # self-child pointer and relationship.
            if resource.full_resource_name == organization.full_resource_name:
                plans[organization.full_resource_name] = _Plan(
                    deployment=_deployment_for_resource(
                        resource,
                        organization_scope=organization_scope,
                        observed_at=snapshot.observed_at,
                        warnings=report.warnings,
                    ),
                    parent_full_resource_name=None,
                    fallback_parent_full_resource_name=None,
                )
                continue
            deepest_scope = organization.full_resource_name
            for folder in resource.folders:
                if _scope_full_name(folder) == resource.full_resource_name:
                    continue
                deepest_scope = _add_scope(
                    plans,
                    folder,
                    organization_scope=organization_scope,
                    observed_at=snapshot.observed_at,
                    parent_full_resource_name=deepest_scope,
                    warnings=report.warnings,
                )
            if resource.project:
                if _scope_full_name(resource.project) != resource.full_resource_name:
                    deepest_scope = _add_scope(
                        plans,
                        resource.project,
                        organization_scope=organization_scope,
                        observed_at=snapshot.observed_at,
                        parent_full_resource_name=deepest_scope,
                        warnings=report.warnings,
                    )
            preferred_parent = resource.parent_full_resource_name
            if preferred_parent == resource.full_resource_name:
                preferred_parent = None
            plans[resource.full_resource_name] = _Plan(
                deployment=_deployment_for_resource(
                    resource,
                    organization_scope=organization_scope,
                    observed_at=snapshot.observed_at,
                    warnings=report.warnings,
                ),
                parent_full_resource_name=preferred_parent or deepest_scope,
                fallback_parent_full_resource_name=deepest_scope,
            )

    # A preferred provider parent is usable only when CAI returned or a scope
    # fallback materialized that parent. Otherwise retain the deepest known
    # scope chosen above.
    for full_name, plan in plans.items():
        parent_name = plan.parent_full_resource_name
        if parent_name is not None and parent_name not in plans:
            fallback = plan.fallback_parent_full_resource_name
            plan.parent_full_resource_name = fallback if fallback != full_name and fallback in plans else None
    return plans, failed_scopes


def _is_managed_gcp_deployment(deployment: Deployment) -> bool:
    resource = deployment.resource
    return bool(
        deployment.target.provider == "gcp"
        and resource is not None
        and deployment.id == gcp_deployment_id(resource.full_resource_name)
    )


def _changed(existing: Deployment, expected: Deployment) -> bool:
    fields = (
        "name",
        "kind",
        "target",
        "resource",
        "status",
        "provider_labels",
        "source_revision",
        "parent_type_id",
        "artifact_id",
        "artifact_link_source",
    )
    return any(getattr(existing, field) != getattr(expected, field) for field in fields)


async def _upsert(expected: Deployment) -> tuple[Deployment, bool, bool, str | None]:
    existing = await Deployment.get_by_id(expected.id)
    if existing is None:
        await expected.save(notify=False)
        return expected, True, False, None

    old_parent = existing.parent_type_id
    if existing.artifact_link_source == ArtifactLinkSource.MANUAL:
        expected.artifact_id = existing.artifact_id
        expected.artifact_link_source = existing.artifact_link_source
    if not _changed(existing, expected):
        return existing, False, False, old_parent

    for field in (
        "name",
        "kind",
        "target",
        "resource",
        "status",
        "provider_labels",
        "source_revision",
        "parent_type_id",
        "artifact_id",
        "artifact_link_source",
    ):
        setattr(existing, field, getattr(expected, field))
    await existing.save(notify=False)
    return existing, False, True, old_parent


async def reconcile_snapshot(snapshot: InventorySnapshot) -> WorldViewSyncReport:
    """Converge one provider snapshot without deleting provider or local rows."""

    total = len(snapshot.organizations)
    failed = sum(1 for result in snapshot.organizations if result.error)
    state = DeploymentSyncState.PARTIAL if failed else DeploymentSyncState.CURRENT
    if total and failed == total:
        state = DeploymentSyncState.ERROR
    report = WorldViewSyncReport(
        provider=snapshot.provider,
        state=state,
        observed_at=snapshot.observed_at,
        organizations_total=total,
        organizations_succeeded=total - failed,
        organizations_failed=failed,
        resources_seen=sum(len(result.resources) for result in snapshot.organizations if not result.error),
    )
    plans, failed_scopes = _plans_for_snapshot(snapshot, report)
    seen_ids = {gcp_deployment_id(full_name) for full_name in plans}
    seen_ids.add(WORLDVIEW_ROOT_ID)

    existing_deployments = await Deployment.get_all()
    stale_candidates = [
        deployment
        for deployment in existing_deployments
        if _is_managed_gcp_deployment(deployment)
        and deployment.id not in seen_ids
        and deployment.target.scope not in failed_scopes
        and deployment.status.sync_state != DeploymentSyncState.STALE
    ]
    report.stale = len(stale_candidates)

    root = _root_deployment(report)
    root.parent_type_id = None
    materialized: dict[str, Deployment] = {}
    old_parents: dict[str, str | None] = {}
    saved_root, created, updated, old_parent = await _upsert(root)
    report.created += int(created)
    report.updated += int(updated)
    materialized[WORLDVIEW_ROOT_KEY] = saved_root
    old_parents[saved_root.id] = old_parent

    for full_name, plan in plans.items():
        parent_name = plan.parent_full_resource_name
        parent_id = gcp_deployment_id(parent_name) if parent_name is not None else WORLDVIEW_ROOT_ID
        plan.deployment.parent_type_id = _typeid(parent_id)
        saved, created, updated, old_parent = await _upsert(plan.deployment)
        report.created += int(created)
        report.updated += int(updated)
        materialized[full_name] = saved
        old_parents[saved.id] = old_parent

    for deployment in stale_candidates:
        deployment.status = DeploymentStatus(
            sync_state=DeploymentSyncState.STALE,
            provider_state=deployment.status.provider_state,
            observed_at=snapshot.observed_at,
            message="Not present in the latest successful organization inventory",
        )
        await deployment.save(notify=False)
        report.updated += 1

    # Reflect every canonical parent pointer through the normal is_child edge.
    for deployment in materialized.values():
        parent_type_id = deployment.parent_type_id
        if parent_type_id is None:
            continue
        parent_ref = TypeId(parent_type_id)
        parent = await Deployment.get_by_id(parent_ref.id)
        if parent is None:
            continue
        old_parent = old_parents.get(deployment.id)
        if old_parent and old_parent != parent_type_id:
            try:
                old_ref = TypeId(old_parent)
                old_entity = await Deployment.get_by_id(old_ref.id)
                if old_entity is not None:
                    await old_entity.detach_child(deployment.typeid)
            except ValueError:
                pass
        await parent.attach_child(deployment)

    return report


async def reconcile_provider_error(provider: str, message: str) -> WorldViewSyncReport:
    """Persist an honest root error while preserving every prior resource."""

    report = WorldViewSyncReport(
        provider=provider,
        state=DeploymentSyncState.ERROR,
        observed_at=utc_now_iso(),
        warnings=[message],
    )
    root = _root_deployment(report)
    root.status.message = message
    existing = await Deployment.get_by_id(WORLDVIEW_ROOT_ID)
    if existing is not None:
        root.provider_labels = dict(existing.provider_labels)
    _, created, updated, _ = await _upsert(root)
    report.created = int(created)
    report.updated = int(updated)
    return report


def sync_report_from_root(root: Deployment | None) -> WorldViewSyncReport | None:
    if root is None:
        return None

    def count(name: str) -> int:
        try:
            return int(root.provider_labels.get(f"{_SYNC_LABEL_PREFIX}{name}", "0"))
        except (TypeError, ValueError):
            return 0

    return WorldViewSyncReport(
        provider=root.target.provider,
        state=root.status.sync_state,
        observed_at=root.status.observed_at,
        organizations_total=count("organizations_total"),
        organizations_succeeded=count("organizations_succeeded"),
        organizations_failed=count("organizations_failed"),
        resources_seen=count("resources_seen"),
        stale=count("stale"),
        warnings=[root.status.message] if root.status.message else [],
    )


__all__ = [
    "WORLDVIEW_ROOT_ID",
    "WORLDVIEW_ROOT_KEY",
    "gcp_deployment_id",
    "reconcile_provider_error",
    "reconcile_snapshot",
    "sync_report_from_root",
]
