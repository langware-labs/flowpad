"""Read-only Google Cloud inventory through gcloud Cloud Asset Inventory."""

from __future__ import annotations

import asyncio
import json
import os
import re
from collections.abc import Awaitable, Callable
from typing import Any

from flow_sdk.worldview.models import (
    InventoryOrganization,
    InventoryResource,
    InventorySnapshot,
    OrganizationInventory,
    utc_now_iso,
)
from flow_sdk.worldview.ontology import normalize_kind
from flow_sdk.worldview.providers.base import InventoryProviderError

GCP_ARTIFACT_LABEL = "flowpad_artifact_id"
GCP_BILLING_PROJECT_ENV = "FLOWPAD_GCP_BILLING_PROJECT"
_READ_MASK = ",".join(
    (
        "name",
        "assetType",
        "project",
        "folders",
        "organization",
        "displayName",
        "location",
        "labels",
        "state",
        "parentFullResourceName",
    )
)

JSONRunner = Callable[[list[str]], Awaitable[list[dict[str, Any]]]]


def _camel_segment(value: str) -> str:
    value = re.sub(r"(?<!^)(?=[A-Z])", "_", value)
    value = re.sub(r"[^a-zA-Z0-9_-]+", "_", value)
    return value.strip("_").lower() or "resource"


def gcp_kind_from_asset_type(asset_type: str) -> str:
    """Mechanically map a CAI asset type to the open dot ontology."""

    service_part, separator, resource_part = str(asset_type).strip().partition("/")
    service = service_part.removesuffix(".googleapis.com").split(".", 1)[0]
    parts = [_camel_segment(service or "resource")]
    if separator:
        parts.extend(_camel_segment(part) for part in resource_part.split("/") if part)
    else:
        parts.append("resource")
    return normalize_kind("gcp." + ".".join(parts))


def _scope_id(value: Any, prefix: str) -> str | None:
    text = str(value).strip() if value is not None else ""
    if not text:
        return None
    return text if text.startswith(f"{prefix}/") else f"{prefix}/{text.rsplit('/', 1)[-1]}"


def _labels(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    return {str(key): str(item) for key, item in value.items() if item is not None}


def parse_gcp_organization(row: dict[str, Any]) -> InventoryOrganization:
    raw_name = str(row.get("name") or "").strip()
    org_id = raw_name.rsplit("/", 1)[-1]
    if not org_id:
        raise ValueError("organization row has no id")
    return InventoryOrganization(
        id=org_id,
        name=str(row.get("displayName") or raw_name or org_id),
        full_resource_name=f"//cloudresourcemanager.googleapis.com/organizations/{org_id}",
    )


def parse_gcp_resource(row: dict[str, Any]) -> InventoryResource:
    full_name = str(row.get("name") or "").strip()
    asset_type = str(row.get("assetType") or "").strip()
    if not full_name or not asset_type:
        raise ValueError("Cloud Asset Inventory row requires name and assetType")
    folders = row.get("folders") if isinstance(row.get("folders"), list) else []
    attrs = row.get("additionalAttributes")
    provider_uid = attrs.get("resourceId") if isinstance(attrs, dict) else None
    provider_uid = str(provider_uid) if provider_uid not in (None, "") else None
    return InventoryResource(
        full_resource_name=full_name,
        asset_type=asset_type,
        name=str(row.get("displayName") or full_name.rsplit("/", 1)[-1] or asset_type),
        parent_full_resource_name=str(row.get("parentFullResourceName") or "").strip() or None,
        provider_uid=provider_uid,
        organization=_scope_id(row.get("organization"), "organizations"),
        folders=[scope for value in folders if (scope := _scope_id(value, "folders"))],
        project=_scope_id(row.get("project"), "projects"),
        location=str(row.get("location") or "").strip() or None,
        labels=_labels(row.get("labels")),
        provider_state=str(row.get("state") or "").strip() or None,
        # A provider update timestamp is observation metadata, not a source
        # revision. Resource-specific revision inference is intentionally out
        # of scope for this generic CAI reader.
        source_revision=None,
    )


async def _gcloud_json(args: list[str]) -> list[dict[str, Any]]:
    try:
        process = await asyncio.create_subprocess_exec(
            "gcloud",
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except OSError as exc:
        raise InventoryProviderError(f"could not start gcloud: {exc}") from exc
    stdout, stderr = await process.communicate()
    if process.returncode != 0:
        detail = stderr.decode("utf-8", errors="replace").strip()
        raise InventoryProviderError(detail or f"gcloud exited with status {process.returncode}")
    try:
        payload = json.loads(stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise InventoryProviderError("gcloud returned invalid JSON") from exc
    if not isinstance(payload, list) or not all(isinstance(row, dict) for row in payload):
        raise InventoryProviderError("gcloud JSON result must be a list of objects")
    return payload


class GCPInventoryProvider:
    """Inventory every CAI-searchable resource in every visible organization."""

    name = "gcp"

    def __init__(
        self,
        runner: JSONRunner | None = None,
        billing_project: str | None = None,
    ) -> None:
        self._runner = runner or _gcloud_json
        configured_project = billing_project if billing_project is not None else os.environ.get(GCP_BILLING_PROJECT_ENV)
        self._billing_project = str(configured_project or "").strip() or None

    async def collect(self) -> InventorySnapshot:
        organization_rows = await self._runner(["organizations", "list", "--quiet", "--format=json"])
        organizations: list[OrganizationInventory] = []
        for row in organization_rows:
            try:
                organization = parse_gcp_organization(row)
            except ValueError:
                continue
            try:
                resource_args = [
                    "asset",
                    "search-all-resources",
                    f"--scope=organizations/{organization.id}",
                    f"--read-mask={_READ_MASK}",
                ]
                if self._billing_project:
                    resource_args.append(f"--billing-project={self._billing_project}")
                resource_args.extend(("--quiet", "--format=json"))
                resource_rows = await self._runner(resource_args)
                resources: list[InventoryResource] = []
                for resource_row in resource_rows:
                    try:
                        resources.append(parse_gcp_resource(resource_row))
                    except ValueError:
                        continue
                organizations.append(OrganizationInventory(organization=organization, resources=resources))
            except InventoryProviderError as exc:
                organizations.append(OrganizationInventory(organization=organization, error=str(exc)))
        return InventorySnapshot(
            provider=self.name,
            observed_at=utc_now_iso(),
            organizations=organizations,
        )


__all__ = [
    "GCP_ARTIFACT_LABEL",
    "GCP_BILLING_PROJECT_ENV",
    "GCPInventoryProvider",
    "gcp_kind_from_asset_type",
    "parse_gcp_organization",
    "parse_gcp_resource",
]
