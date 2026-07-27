"""Deployment entity: desired/observed placement of an Artifact or resource."""

from __future__ import annotations

from typing import Any

from pydantic import field_validator

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType
from flow_sdk.worldview.models import (
    ArtifactLinkSource,
    DeploymentObservation,
    DeploymentObservationKind,
    DeploymentStatus,
    DeploymentTarget,
    ExternalResourceRef,
)
from flow_sdk.worldview.ontology import normalize_kind


class Deployment(Entity):
    """A provider-neutral placement and observation record.

    A Deployment may point to an Artifact explicitly, or stand alone for an
    inventoried external resource. Provider hierarchy uses the inherited
    ``parent_type_id`` field.
    """

    type: str = APIField(default=EntityType.DEPLOYMENT.value)
    name: str = APIField(description="Display name")
    kind: str = APIField(description="Open dot-path ontology kind")
    artifact_id: str | None = APIField(default=None, description="Explicit linked Artifact id")
    artifact_link_source: ArtifactLinkSource | None = APIField(default=None)
    target: DeploymentTarget = APIField(description="Provider placement target")
    resource: ExternalResourceRef | None = APIField(default=None, description="Observed provider resource")
    status: DeploymentStatus = APIField(default_factory=DeploymentStatus)
    provider_labels: dict[str, str] = APIField(
        default_factory=dict,
        description="Provider-native labels and local-provider configuration",
    )
    observations: dict[DeploymentObservationKind, DeploymentObservation] = APIField(
        default_factory=dict,
        description="Provider-normalized cost, size, and activity observations",
    )
    source_revision: str | None = APIField(default=None)

    def __init__(self, **data: Any) -> None:
        data["id"] = self.allocate_id(data)
        super().__init__(**data)

    @property
    def runtime_port(self) -> int | None:
        """The local dev-server port this placement runs on, if any.

        Callers kept re-deriving this from the raw label — parse, swallow
        ValueError, sometimes range-check, sometimes not. Owning it here means a
        junk label reads as "no port" everywhere instead of only where someone
        remembered to guard.
        """
        raw = (self.provider_labels or {}).get("flowpad.runtime.port")
        try:
            port = int(str(raw))
        except (TypeError, ValueError):
            return None
        return port if 0 < port <= 65535 else None

    @field_validator("kind", mode="before")
    @classmethod
    def _valid_kind(cls, value: Any) -> str:
        return normalize_kind(value)

    @field_validator("artifact_id", mode="before")
    @classmethod
    def _valid_artifact_id(cls, value: Any) -> str | None:
        if value in (None, ""):
            return None
        candidate = str(value).strip()
        if not is_valid_entity_id(candidate):
            raise ValueError("artifact_id must be a UUID v4 or v5")
        return candidate

    @field_validator("provider_labels", mode="before")
    @classmethod
    def _string_provider_labels(cls, value: Any) -> dict[str, str]:
        if value is None:
            return {}
        if not isinstance(value, dict):
            raise ValueError("Deployment provider_labels must be an object")
        return {str(key): str(item) for key, item in value.items() if item is not None}

    @field_validator("observations")
    @classmethod
    def _temporal_observation_windows(
        cls,
        value: dict[DeploymentObservationKind, DeploymentObservation],
    ) -> dict[DeploymentObservationKind, DeploymentObservation]:
        for kind in (DeploymentObservationKind.COST, DeploymentObservationKind.ACTIVITY):
            observation = value.get(kind)
            if observation and (observation.window_start is None or observation.window_end is None):
                raise ValueError(f"{kind.value} observation requires a declared window")
        return value


__all__ = ["Deployment"]
