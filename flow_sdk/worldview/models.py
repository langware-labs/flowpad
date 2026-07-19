"""Provider-neutral WorldView DTOs and Deployment value objects."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from math import isfinite
from typing import Any

from pydantic import BaseModel, Field, field_validator, model_validator

from flow_sdk._compat import StrEnum
from flow_sdk.worldview.ontology import normalize_kind

_RFC3339_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)


def _rfc3339(value: Any, *, optional: bool = False) -> str | None:
    if value is None and optional:
        return None
    if not isinstance(value, str):
        raise ValueError("timestamp must be an RFC3339 string")
    text = value.strip()
    if not _RFC3339_PATTERN.fullmatch(text):
        raise ValueError("timestamp must be an RFC3339 string with a timezone")
    try:
        datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("timestamp must be a valid RFC3339 instant") from exc
    return text


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class ArtifactLinkSource(StrEnum):
    MANUAL = "manual"
    GCP_LABEL = "gcp_label"


class DeploymentSyncState(StrEnum):
    CURRENT = "current"
    STALE = "stale"
    PARTIAL = "partial"
    ERROR = "error"


class ObservationCoverage(StrEnum):
    AVAILABLE = "available"
    UNAVAILABLE = "unavailable"
    UNATTRIBUTED = "unattributed"
    STALE = "stale"


class DeploymentObservationKind(StrEnum):
    COST = "cost"
    SIZE = "size"
    ACTIVITY = "activity"


class DeploymentObservation(BaseModel):
    """One provider-normalized value suitable for WorldView presentation."""

    metric: str
    coverage: ObservationCoverage = ObservationCoverage.AVAILABLE
    value: float | None = None
    unit: str | None = None
    observed_at: str
    window_start: str | None = None
    window_end: str | None = None
    source: str

    @field_validator("metric", mode="before")
    @classmethod
    def _valid_metric(cls, value: Any) -> str:
        if not isinstance(value, str):
            raise ValueError("metric must be a string")
        return normalize_kind(value)

    @field_validator("source", mode="before")
    @classmethod
    def _required_text(cls, value: Any) -> str:
        if not isinstance(value, str):
            raise ValueError("value must be a string")
        text = value.strip()
        if not text:
            raise ValueError("value must not be empty")
        return text

    @field_validator("unit", mode="before")
    @classmethod
    def _optional_text(cls, value: Any) -> str | None:
        if value is None:
            return None
        if not isinstance(value, str):
            raise ValueError("value must be a string")
        text = value.strip()
        return text or None

    @field_validator("value", mode="before")
    @classmethod
    def _strict_number(cls, value: Any) -> float | None:
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("observation value must be a number")
        return float(value)

    @field_validator("observed_at", mode="before")
    @classmethod
    def _observed_timestamp(cls, value: Any) -> str:
        return str(_rfc3339(value))

    @field_validator("window_start", "window_end", mode="before")
    @classmethod
    def _window_timestamp(cls, value: Any) -> str | None:
        return _rfc3339(value, optional=True)

    @model_validator(mode="after")
    def _coverage_matches_value(self) -> DeploymentObservation:
        if (self.window_start is None) != (self.window_end is None):
            raise ValueError("observation window_start and window_end must be provided together")
        if self.window_start and self.window_end:
            start = datetime.fromisoformat(self.window_start.replace("Z", "+00:00"))
            end = datetime.fromisoformat(self.window_end.replace("Z", "+00:00"))
            if start >= end:
                raise ValueError("observation window_start must be before window_end")
        has_value = self.value is not None
        if has_value and not isfinite(self.value):
            raise ValueError("observation value must be finite")
        if self.coverage in {ObservationCoverage.AVAILABLE, ObservationCoverage.STALE}:
            if not has_value:
                raise ValueError(f"{self.coverage.value} observation requires a value")
            if not self.unit:
                raise ValueError(f"{self.coverage.value} observation requires a unit")
        elif has_value:
            raise ValueError(f"{self.coverage.value} observation must not carry a value")
        return self


class DeploymentTarget(BaseModel):
    provider: str
    scope: str
    location: str | None = None

    @field_validator("provider", "scope", mode="before")
    @classmethod
    def _required_text(cls, value: Any) -> str:
        text = str(value).strip() if value is not None else ""
        if not text:
            raise ValueError("value must not be empty")
        return text

    @field_validator("location", mode="before")
    @classmethod
    def _optional_text(cls, value: Any) -> str | None:
        text = str(value).strip() if value is not None else ""
        return text or None


class ExternalResourceRef(BaseModel):
    full_resource_name: str
    asset_type: str
    parent_full_resource_name: str | None = None
    provider_uid: str | None = None

    @field_validator("full_resource_name", "asset_type", mode="before")
    @classmethod
    def _required_text(cls, value: Any) -> str:
        text = str(value).strip() if value is not None else ""
        if not text:
            raise ValueError("value must not be empty")
        return text

    @field_validator("parent_full_resource_name", "provider_uid", mode="before")
    @classmethod
    def _optional_text(cls, value: Any) -> str | None:
        text = str(value).strip() if value is not None else ""
        return text or None


class DeploymentStatus(BaseModel):
    sync_state: DeploymentSyncState = DeploymentSyncState.CURRENT
    provider_state: str | None = None
    observed_at: str | None = None
    message: str | None = None


class InventoryOrganization(BaseModel):
    id: str
    name: str
    full_resource_name: str


class InventoryResource(BaseModel):
    full_resource_name: str
    asset_type: str
    name: str
    parent_full_resource_name: str | None = None
    provider_uid: str | None = None
    organization: str | None = None
    folders: list[str] = Field(default_factory=list)
    project: str | None = None
    location: str | None = None
    labels: dict[str, str] = Field(default_factory=dict)
    provider_state: str | None = None
    source_revision: str | None = None


class OrganizationInventory(BaseModel):
    organization: InventoryOrganization
    resources: list[InventoryResource] = Field(default_factory=list)
    error: str | None = None


class InventorySnapshot(BaseModel):
    provider: str
    observed_at: str = Field(default_factory=utc_now_iso)
    organizations: list[OrganizationInventory] = Field(default_factory=list)


class WorldViewSyncReport(BaseModel):
    provider: str = "gcp"
    state: DeploymentSyncState = DeploymentSyncState.CURRENT
    observed_at: str | None = None
    organizations_total: int = 0
    organizations_succeeded: int = 0
    organizations_failed: int = 0
    resources_seen: int = 0
    created: int = 0
    updated: int = 0
    stale: int = 0
    warnings: list[str] = Field(default_factory=list)


class WorldViewNode(BaseModel):
    type: str
    id: str
    key: str
    label: str | None = None
    is_ghost: bool = False
    properties: dict[str, Any] = Field(default_factory=dict)


class WorldViewEndpoint(BaseModel):
    type: str
    id: str


class WorldViewEdge(BaseModel):
    from_: WorldViewEndpoint = Field(alias="from")
    to: WorldViewEndpoint
    kind: str

    model_config = {"populate_by_name": True}


class WorldViewGraph(BaseModel):
    root: str | None = None
    nodes: list[WorldViewNode] = Field(default_factory=list)
    edges: list[WorldViewEdge] = Field(default_factory=list)
    counts: dict[str, int] = Field(default_factory=lambda: {"nodes": 0, "edges": 0})
    sync: WorldViewSyncReport | None = None


class LinkArtifactRequest(BaseModel):
    artifact_id: str


__all__ = [
    "ArtifactLinkSource",
    "DeploymentObservation",
    "DeploymentObservationKind",
    "DeploymentStatus",
    "DeploymentSyncState",
    "DeploymentTarget",
    "ExternalResourceRef",
    "InventoryOrganization",
    "InventoryResource",
    "InventorySnapshot",
    "LinkArtifactRequest",
    "OrganizationInventory",
    "ObservationCoverage",
    "WorldViewEdge",
    "WorldViewEndpoint",
    "WorldViewGraph",
    "WorldViewNode",
    "WorldViewSyncReport",
    "normalize_kind",
    "utc_now_iso",
]
