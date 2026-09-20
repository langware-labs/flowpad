"""Logical Artifact entity: composition identity plus optional source origin."""

from __future__ import annotations

from pathlib import Path
from typing import Any, ClassVar

from pydantic import field_validator, model_validator

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.fs_store.origin.local_origin import local_origin_for_path
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType
from flow_sdk.worldview.ontology import KindStr, kind_matches

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


class Artifact(Entity):
    """A provider-neutral logical component in an application composition.

    Parentage uses the inherited ``parent_type_id`` field. Runtime placement
    and observed provider state intentionally live on ``Deployment``.
    """

    type: str = APIField(default=EntityType.ARTIFACT.value)
    name: str = APIField(description="Display name")
    kind: KindStr = APIField(description="Open dot-path ontology kind")
    description: str | None = APIField(default=None, description="Human-readable description")
    #: An artifact REFERENCES an asset; it never owns the path. Both rows carry
    #: the same ``asset_ref``, so without this the artifact would compete with
    #: the real entity in ``Entity.get_by_asset_ref`` and win or lose by registry
    #: order. Resolution goes the other way: read ``asset_ref``, then ask
    #: ``get_by_asset_ref`` for the entity that does own it.
    owns_asset_ref: ClassVar[bool] = False

    asset_ref: str = APIField(default="", sharing=Sharing.PRIVATE)
    target_type_id: str | None = APIField(
        default=None,
        description=(
            "TypeId of the entity this artifact references, e.g. "
            "``source_item-<uuid>``. ``asset_ref`` addresses a deliverable that "
            "is a *file*; this addresses one that is a *row*. A message an agent "
            "sent, a task it opened, a record it created — none of them have a "
            "path, and without this the artifact would carry an empty "
            "``asset_ref`` and point at nothing at all. Both may be set: a "
            "file-backed entity has a path AND an identity."
        ),
    )
    generated_by: str | None = APIField(
        default=None,
        description=(
            "TypeId of the run that produced this artifact, e.g. "
            "``agentic_process-<uuid>``. A TypeId rather than a bare uuid so a "
            "graph-workflow run or a subagent can be a producer too. The edge "
            "lives here, not as a list on the process: 'this run's artifacts' is "
            "a match query, so concurrent registrations cannot clobber one "
            "another. Deliberately NOT a revival of the retired "
            "``generating_flow_id`` — provenance that was dropped stays dropped."
        ),
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
        raw_path = str(data.get("path") or "").strip()
        if data.get("origin") is None and raw_path and Path(raw_path).expanduser().is_absolute():
            # The registration input names a PATH; the origin is its local locator.
            data["origin"] = local_origin_for_path(Path(raw_path).expanduser())
        return data

    @classmethod
    async def find_existing(
        cls,
        *,
        generated_by: str | None = None,
        project_id: str | None = None,
        asset_ref: str | None = None,
        target_type_id: str | None = None,
        origin_path: str | None = None,
    ) -> "Artifact | None":
        """The artifact already registered for this address in this scope, or None.

        THE idempotency seam for registration. Re-registering converges here
        rather than on a derived id: an id is a name, not a fact about the
        thing, and a key baked into one can never change afterwards. Same shape
        as ``Deployment.find_existing`` / ``SourceItem.find_existing``.

        **Scope is the caller's, and the two differ on purpose:**

        * ``generated_by`` — RUN scope, for a file or a row. One run
          re-registering the same deliverable converges; a DIFFERENT run
          producing the same path gets its own artifact, because provenance is
          per-run and an artifact may itself be an event ("a message it sent").
        * ``project_id`` — PROJECT scope, for a web app. An app is a durable
          asset of the project, not of the run that happened to build it, so
          any run re-registering it converges on the one row.

        Addresses are tried in declaration order and any one is sufficient.
        ``origin_path`` is the canonical POSIX path of a LOCAL origin — it lives
        inside a JSON column, so like ``Deployment.target.provider`` it is
        matched in Python rather than in the query. The row count per scope is
        small (one run's or one project's artifacts), so the others ride along
        rather than forking a second query per address.
        """
        if (generated_by is None) == (project_id is None):
            raise ValueError("find_existing takes exactly one scope: generated_by or project_id")
        if not (asset_ref or target_type_id or origin_path):
            # No address is not a wildcard — it is a caller bug that would
            # otherwise converge on an arbitrary row of the scope.
            return None

        scope = {"generated_by": generated_by} if generated_by is not None else {"project_id": project_id}
        for row in await cls.get_all({"match": scope}):
            if asset_ref and row.asset_ref == asset_ref:
                return row
            if target_type_id and row.target_type_id == target_type_id:
                return row
            if origin_path and row.local_origin_path() == origin_path:
                return row
        return None

    def local_origin_path(self) -> str | None:
        """Canonical POSIX path of this artifact's LOCAL origin, else None.

        A git-backed origin deliberately answers None: two checkouts of one repo
        are the same origin but different paths, so a path match there would
        converge rows that are not the same placement.
        """
        from flow_sdk.fs_store.path_utils import canonical_posix_path  # noqa: PLC0415

        origin = self.origin
        if getattr(origin, "kind", None) != "local":
            return None
        return canonical_posix_path(str(Path(origin.base) / origin.rel_path))

    async def setup_on_receive(self, *, project_id=None, workdir=None) -> dict:
        """Only application.web artifacts invoke the artifact setup skill."""

        if kind_matches("application.web", self.kind):
            return await super().setup_on_receive(project_id=project_id, workdir=workdir)
        from flow_sdk.core.display_target import _entity_payload  # noqa: PLC0415

        return _entity_payload(self)


__all__ = ["Artifact", "LEGACY_ARTIFACT_KIND_MAP"]
