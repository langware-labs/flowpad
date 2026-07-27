"""Logical Artifact entity: composition identity plus optional source origin."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic import field_validator, model_validator

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.builtin.fs_origin_field import FSOriginField
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType
from flow_sdk.worldview.ontology import kind_matches, normalize_kind

LEGACY_ARTIFACT_KIND_MAP: dict[str, str] = {
    "WEBAPP": "application.web",
    "WEBPAGE": "content.web.page",
    "APP_SERVICE": "workload.service",
    "CLOUD_SERVICE": "resource.infrastructure",
    "FUNCTION": "workload.function",
    "FILE": "content.file",
    "TEXT_FILE": "content.file.text",
    "DATA": "content.data",
}


def _legacy_origin(data: dict[str, Any]) -> dict[str, Any] | None:
    origin = data.get("origin") or data.get("git_origin")
    metadata = data.get("metadata")
    if origin is None and isinstance(metadata, dict):
        origin = metadata.get("git_origin")
    if isinstance(origin, dict):
        normalized = dict(origin)
        normalized.setdefault("kind", "git")
        return normalized

    raw_path = str(data.get("path") or "").strip()
    if not raw_path:
        return None
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        return None
    if path.name:
        return {"kind": "local", "base": str(path.parent), "rel_path": path.name}
    return {"kind": "local", "base": str(path), "rel_path": "."}


class Artifact(Entity):
    """A provider-neutral logical component in an application composition.

    Parentage uses the inherited ``parent_type_id`` field. Runtime placement
    and observed provider state intentionally live on ``Deployment``.
    """

    type: str = APIField(default=EntityType.ARTIFACT.value)
    name: str = APIField(description="Display name")
    kind: str = APIField(description="Open dot-path ontology kind")
    description: str | None = APIField(default=None, description="Human-readable description")
    origin: FSOriginField | None = APIField(
        default=None,
        description="Optional source locator (for example GitOrigin or LocalOrigin)",
    )

    def __init__(self, **data: Any) -> None:
        data["id"] = self.allocate_id(data)
        super().__init__(**data)

    @model_validator(mode="before")
    @classmethod
    def _read_legacy_shape(cls, value: Any) -> Any:
        """Tolerate legacy rows while emitting only the new Artifact shape."""

        if not isinstance(value, dict):
            return value
        data = dict(value)
        if not data.get("kind"):
            old_type = str(data.get("artifact_type") or "FILE").strip().upper()
            data["kind"] = LEGACY_ARTIFACT_KIND_MAP.get(old_type, "content.file")
        if data.get("origin") is None:
            origin = _legacy_origin(data)
            if origin is not None:
                data["origin"] = origin
        return data

    @field_validator("kind", mode="before")
    @classmethod
    def _valid_kind(cls, value: Any) -> str:
        return normalize_kind(value)

    async def setup_on_receive(self, *, project_id=None, workdir=None) -> dict:
        """Only application.web artifacts invoke the artifact setup skill."""

        if kind_matches("application.web", self.kind):
            return await super().setup_on_receive(project_id=project_id, workdir=workdir)
        from flow_sdk.core.display_target import _entity_payload  # noqa: PLC0415

        return _entity_payload(self)


__all__ = ["Artifact", "LEGACY_ARTIFACT_KIND_MAP"]
