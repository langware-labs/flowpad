"""Idempotent provider-inventory materialization into Deployment entities.

A provider is a *type of deployment*, never a parent of anything. So an
inventory sync produces exactly one Deployment per REAL provider resource —
there are no synthesized rows for the organization/folder/project chain the
resource happens to sit under, and no fake root row standing in for "Google
Cloud". That chain is provider coordinates, and it lives in ``target.scope``
where every other where-am-I answer lives.

Inventoried resources are DISCOVERED, not placed by us, so they have no
deployed element and therefore no ``parent_type_id``. That is the honest shape:
a parent would have to be invented, and inventing one is what produced the fake
tree in the first place.

Convergence is by LOOKUP on the natural key (provider + the provider's own
resource name), never by deriving an id — an id is a name, not a fact about the
thing, and once minted it never changes.
"""

from __future__ import annotations

from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.fs_store.origin.cloud_origin import CloudOrigin
from flow_sdk.builtin.deployment import Deployment
from flow_sdk.worldview.models import (
    ArtifactLinkSource,
    DeploymentStatus,
    DeploymentSyncState,
    DeploymentTarget,
    InventoryResource,
    InventorySnapshot,
    WorldViewSyncReport,
    utc_now_iso,
)
from flow_sdk.worldview.providers.gcp import GCP_ARTIFACT_LABEL, gcp_kind_from_asset_type

_MUTABLE_FIELDS = (
    "name",
    "kind",
    "target",
    "origin",
    "status",
    "provider_labels",
    "source_revision",
    "artifact_id",
    "artifact_link_source",
)


def _origin(provider: str, resource: InventoryResource) -> CloudOrigin:
    """Where this record's truth lives — the provider's own resource name.

    Same value object the ingest side uses for a Gmail message or a Slack post,
    for the same reason: a secret-free, serializable pointer at a mutable object
    in someone else's system.
    """
    return CloudOrigin(
        kind=provider,
        provider=provider,
        external_id=resource.full_resource_name,
        url=resource.provider_uid or "",
    )


def _deployment_payload(
    resource: InventoryResource,
    *,
    provider: str,
    organization_scope: str,
    observed_at: str,
    warnings: list[str],
) -> dict:
    artifact_id: str | None = None
    artifact_link_source: ArtifactLinkSource | None = None
    label_id = resource.labels.get(GCP_ARTIFACT_LABEL)
    if label_id:
        if is_valid_entity_id(label_id):
            artifact_id = label_id
            artifact_link_source = ArtifactLinkSource.GCP_LABEL
        else:
            warnings.append(f"{resource.full_resource_name}: ignored invalid {GCP_ARTIFACT_LABEL} label")

    # The provider hierarchy, flattened into the scope coordinate. This is the
    # whole of what the synthesized org/folder/project rows used to carry.
    scope_parts = [part for part in (organization_scope, *resource.folders, resource.project) if part]
    return {
        "name": resource.name,
        "kind": gcp_kind_from_asset_type(resource.asset_type),
        "artifact_id": artifact_id,
        "artifact_link_source": artifact_link_source,
        "target": DeploymentTarget(
            provider=provider,
            scope="/".join(scope_parts) or organization_scope,
            location=resource.location,
        ),
        "origin": _origin(provider, resource),
        "status": DeploymentStatus(
            sync_state=DeploymentSyncState.CURRENT,
            provider_state=resource.provider_state,
            observed_at=observed_at,
        ),
        "provider_labels": resource.labels,
        "source_revision": resource.source_revision,
    }


def _is_managed(deployment: Deployment, provider: str) -> bool:
    """Rows this reconciler owns: same provider, and carrying a provider origin."""
    origin = deployment.origin
    return bool(deployment.target.provider == provider and origin and origin.external_id)


def _changed(existing: Deployment, payload: dict) -> bool:
    candidate = Deployment(id=existing.id, **payload)
    keys = set(payload)
    return existing.model_dump(mode="json", include=keys) != candidate.model_dump(mode="json", include=keys)


async def reconcile_snapshot(snapshot: InventorySnapshot) -> WorldViewSyncReport:
    """Converge one provider snapshot without deleting provider or local rows."""

    provider = snapshot.provider
    total = len(snapshot.organizations)
    failed = sum(1 for result in snapshot.organizations if result.error)
    state = DeploymentSyncState.PARTIAL if failed else DeploymentSyncState.CURRENT
    if total and failed == total:
        state = DeploymentSyncState.ERROR
    report = WorldViewSyncReport(
        provider=provider,
        state=state,
        observed_at=snapshot.observed_at,
        organizations_total=total,
        organizations_succeeded=total - failed,
        organizations_failed=failed,
        resources_seen=sum(len(result.resources) for result in snapshot.organizations if not result.error),
    )

    # One read, indexed by the natural key — the alternative is a lookup query
    # per resource, and an inventory is exactly the shape where that becomes a
    # full table scan per row.
    known = await Deployment.get_all({"match": {"type": Deployment.get_type()}})
    by_external: dict[str, Deployment] = {
        d.origin.external_id: d for d in known if _is_managed(d, provider)
    }

    seen: set[str] = set()
    failed_scopes: set[str] = set()
    for result in snapshot.organizations:
        organization_scope = f"organizations/{result.organization.id}"
        if result.error:
            failed_scopes.add(organization_scope)
            report.warnings.append(f"{organization_scope}: {result.error}")
            continue

        for resource in result.resources:
            payload = _deployment_payload(
                resource,
                provider=provider,
                organization_scope=organization_scope,
                observed_at=snapshot.observed_at,
                warnings=report.warnings,
            )
            seen.add(resource.full_resource_name)
            existing = by_external.get(resource.full_resource_name)
            if existing is None:
                await Deployment(**payload).save(notify=False)
                report.created += 1
                continue
            # A hand-made link is a human decision; a provider label must never
            # silently overwrite it on the next sync.
            if existing.artifact_link_source == ArtifactLinkSource.MANUAL:
                payload["artifact_id"] = existing.artifact_id
                payload["artifact_link_source"] = existing.artifact_link_source
            if _changed(existing, payload):
                existing.apply_field_updates(payload)
                await existing.save(notify=False)
                report.updated += 1

    # Not-seen is only meaningful for a scope whose inventory actually SUCCEEDED
    # — otherwise a failed org would mark its entire estate stale.
    stale = [
        d
        for external, d in by_external.items()
        if external not in seen
        and d.status.sync_state != DeploymentSyncState.STALE
        and not any(d.target.scope.startswith(scope) for scope in failed_scopes)
    ]
    report.stale = len(stale)
    for deployment in stale:
        deployment.status = DeploymentStatus(
            sync_state=DeploymentSyncState.STALE,
            provider_state=deployment.status.provider_state,
            observed_at=snapshot.observed_at,
            message="Not present in the latest successful organization inventory",
        )
        await deployment.save(notify=False)
        report.updated += 1

    return report


def reconcile_provider_error(provider: str, message: str) -> WorldViewSyncReport:
    """Report a provider that could not be reached, preserving every prior row.

    Deliberately writes NOTHING. The failure is a property of this sync attempt,
    not of any placement, and it used to be smuggled into a fake root row's
    labels — which meant a transport error minted an entity.
    """
    return WorldViewSyncReport(
        provider=provider,
        state=DeploymentSyncState.ERROR,
        observed_at=utc_now_iso(),
        warnings=[message],
    )


__all__ = ["reconcile_provider_error", "reconcile_snapshot"]
