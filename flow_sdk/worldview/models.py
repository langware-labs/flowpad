"""Provider-neutral WorldView DTOs and Deployment value objects."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from math import isfinite
from typing import Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    field_validator,
    model_validator,
)

from flow_sdk._compat import StrEnum
from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.worldview.ontology import normalize_kind

_RFC3339_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$")


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


class WorldViewProjection(StrEnum):
    WORLD = "world"
    ORGANIZATION = "organization"
    DEPLOYMENT = "deployment"


class WorldViewEdgeTopology(StrEnum):
    HIERARCHY = "hierarchy"
    ASSOCIATION = "association"


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


class _WorldViewWireModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


def _require_trimmed_text(value: Any, message: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise ValueError(message)
    return value


def _require_entity_id(value: Any, message: str) -> str:
    if not is_valid_entity_id(value):
        raise ValueError(message)
    return value


class WorldViewNode(_WorldViewWireModel):
    type: StrictStr
    id: StrictStr
    key: StrictStr
    label: StrictStr | None = None
    is_ghost: StrictBool = False
    properties: dict[str, Any] = Field(default_factory=dict)

    @field_validator("type", "key", mode="before")
    @classmethod
    def _required_text(cls, value: Any) -> str:
        return _require_trimmed_text(value, "value must be a non-empty trimmed string")

    @field_validator("id", mode="before")
    @classmethod
    def _valid_entity_id(cls, value: Any) -> str:
        return _require_entity_id(value, "WorldView node id must be a UUID v4 or v5")

    @model_validator(mode="after")
    def _key_matches_identity(self) -> WorldViewNode:
        expected = f"{self.type}-{self.id}"
        if self.key != expected:
            raise ValueError(f"WorldView node key must equal {expected}")
        return self


class WorldViewEndpoint(_WorldViewWireModel):
    type: StrictStr
    id: StrictStr

    @field_validator("type", mode="before")
    @classmethod
    def _valid_type(cls, value: Any) -> str:
        return _require_trimmed_text(value, "endpoint type must be a non-empty trimmed string")

    @field_validator("id", mode="before")
    @classmethod
    def _valid_entity_id(cls, value: Any) -> str:
        return _require_entity_id(value, "WorldView endpoint id must be a UUID v4 or v5")


class WorldViewEdge(_WorldViewWireModel):
    from_: WorldViewEndpoint = Field(alias="from")
    to: WorldViewEndpoint
    kind: StrictStr
    topology: WorldViewEdgeTopology

    @field_validator("kind", mode="before")
    @classmethod
    def _valid_kind(cls, value: Any) -> str:
        return _require_trimmed_text(value, "edge kind must be a non-empty trimmed string")


class WorldViewCounts(_WorldViewWireModel):
    nodes: StrictInt
    edges: StrictInt

    @field_validator("nodes", "edges")
    @classmethod
    def _non_negative(cls, value: int) -> int:
        if value < 0:
            raise ValueError("WorldView counts must be non-negative")
        return value


class WorldViewGraph(_WorldViewWireModel):
    schema_version: Literal[1] = 1
    projection: WorldViewProjection
    root: StrictStr | None = None
    nodes: list[WorldViewNode] = Field(default_factory=list)
    edges: list[WorldViewEdge] = Field(default_factory=list)
    counts: WorldViewCounts
    sync: WorldViewSyncReport | None = None

    @field_validator("schema_version", mode="before")
    @classmethod
    def _strict_schema_version(cls, value: Any) -> int:
        if type(value) is not int or value != 1:
            raise ValueError("schema_version must be the integer 1")
        return value

    @model_validator(mode="after")
    def _validate_graph_integrity(self) -> WorldViewGraph:
        node_keys: set[str] = set()
        for node in self.nodes:
            if node.key in node_keys:
                raise ValueError(f"duplicate WorldView node key: {node.key}")
            node_keys.add(node.key)

        if self.root is not None and self.root not in node_keys:
            raise ValueError("WorldView root must reference an existing node key")

        edge_keys: set[tuple[str, str, str, WorldViewEdgeTopology]] = set()
        for edge in self.edges:
            source_key = f"{edge.from_.type}-{edge.from_.id}"
            target_key = f"{edge.to.type}-{edge.to.id}"
            if source_key not in node_keys or target_key not in node_keys:
                raise ValueError("WorldView edge endpoints must reference existing nodes")
            edge_key = (source_key, target_key, edge.kind, edge.topology)
            if edge_key in edge_keys:
                raise ValueError("duplicate WorldView edge")
            edge_keys.add(edge_key)

        if self.counts.nodes != len(self.nodes) or self.counts.edges != len(self.edges):
            raise ValueError("WorldView counts must match the node and edge arrays")
        return self


class LinkArtifactRequest(BaseModel):
    artifact_id: str


__all__ = [
    "ArtifactLinkSource",
    "DeploymentObservation",
    "DeploymentObservationKind",
    "DeploymentStatus",
    "DeploymentSyncState",
    "DeploymentTarget",
    "InventoryOrganization",
    "InventoryResource",
    "InventorySnapshot",
    "LinkArtifactRequest",
    "OrganizationInventory",
    "ObservationCoverage",
    "WorldViewEdge",
    "WorldViewEdgeTopology",
    "WorldViewEndpoint",
    "WorldViewGraph",
    "WorldViewCounts",
    "WorldViewNode",
    "WorldViewProjection",
    "WorldViewSyncReport",
    "normalize_kind",
    "utc_now_iso",
]
