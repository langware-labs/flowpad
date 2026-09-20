"""The two companions a registered web app gets, one per plane.

An app is one thing in three planes: the **Artifact** records the source a run
produced, the **Deployment** records where it runs, and the **MicroApp**
records how it is delivered. Both companions hang off the SAME artifact id and
are updated rather than forked when the app is re-registered.

This module owns only the payload shapes. Convergence itself belongs to the
entities — ``Deployment.upsert`` and ``MicroApp.get_by_artifact_id`` — and the
placement of an app was never a fact about the agentic process that happened
to build it, which is why none of this is a method on one.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any, Optional

from flow_sdk.schema.data_spec.webapp_spec import WEBAPP_KIND

_log = logging.getLogger(__name__)

#: Where a web build lands, in the order we trust it. Checked only when the
#: registration does not name a ``dist`` itself.
BUILD_OUTPUT_DIRS = ("dist", "build", "out", ".output/public")


async def project_artifacts(project) -> list:
    """This project's web artifacts, newest first."""
    from flow_sdk.builtin.artifact import Artifact  # noqa: PLC0415
    from flow_sdk.core import QueryFilter  # noqa: PLC0415
    from flow_sdk.worldview.ontology import kind_matches  # noqa: PLC0415

    source = project.typeid if project is not None else None
    rows = await Artifact.get_all(QueryFilter.by_type(Artifact.get_type()), source_entity=source)
    webapps = [row for row in rows if kind_matches(WEBAPP_KIND, row.kind)]
    return sorted(webapps, key=lambda row: str(getattr(row, "created_date", "") or ""), reverse=True)


async def project_deployments(project) -> list:
    """This project's web runtime placements."""
    from flow_sdk.builtin.deployment import KIND_WEB, Deployment  # noqa: PLC0415
    from flow_sdk.core import QueryFilter  # noqa: PLC0415
    from flow_sdk.worldview.ontology import kind_matches  # noqa: PLC0415

    source = project.typeid if project is not None else None
    rows = await Deployment.get_all(QueryFilter.by_type(Deployment.get_type()), source_entity=source)
    return [row for row in rows if kind_matches(KIND_WEB, row.kind)]


async def artifact_by_port(project, port) -> Optional[Any]:
    """The project's web artifact currently placed on ``port``, or None.

    The last of the three addresses a re-registration may arrive with, and the
    only one that is not a fact about the Artifact: a port belongs to the
    runtime placement, so the match runs over Deployments and comes back to the
    artifact they point at. An app moved to a new folder but still served on
    the same port converges here.
    """
    from flow_sdk.builtin.artifact import Artifact  # noqa: PLC0415

    if not port:
        return None
    try:
        wanted = int(str(port))
    except (TypeError, ValueError):
        return None
    for deployment in await project_deployments(project):
        # `runtime_port` owns the parse: a junk or out-of-range label reads as
        # "no port" here exactly as it does everywhere else. Comparing the raw
        # label as a string made a malformed one match and converge onto the
        # wrong artifact.
        if deployment.runtime_port == wanted and deployment.artifact_id:
            return await Artifact.get_by_id(deployment.artifact_id)
    return None


async def upsert_artifact(
    *,
    artifact_path: str,
    name: str,
    description: str,
    generated_by: str,
    project,
    port=None,
    artifact_id: str | None = None,
    fallback_project_id: str | None = None,
):
    """The source plane: converge on this app's Artifact, or mint it.

    Three addresses, tried in the order a caller can be most certain of: an
    explicit ``artifact_id``, then the folder the app lives in, then the port
    it is served on. PROJECT-scoped throughout — an app belongs to the project,
    not to whichever run rebuilt it, so any run re-registering the same folder
    converges on the one row.

    ``generated_by`` is BACKFILLED, never reassigned: convergence lands on the
    row the first run created, and that run stays the producer.
    """
    from flow_sdk.builtin.artifact import Artifact  # noqa: PLC0415
    from flow_sdk.fs_store.origin.git_origin import GitOrigin  # noqa: PLC0415
    from flow_sdk.fs_store.origin.local_origin import local_origin_for_path  # noqa: PLC0415

    git_origin = None
    try:
        git_origin = await asyncio.to_thread(GitOrigin.for_asset_path, artifact_path)
    except Exception:
        _log.debug("webapp: could not derive git origin for %s", artifact_path, exc_info=True)
    # THE one way to build a local origin from a path — the bundle, the asset
    # mount and the serializer all agree byte-for-byte with it.
    origin = git_origin or local_origin_for_path(artifact_path)

    artifact = await Artifact.get_by_id(artifact_id) if artifact_id else None
    if artifact is None and project is not None:
        artifact = await Artifact.find_existing(
            project_id=project.id,
            origin_path=artifact_path,
            kind=WEBAPP_KIND,
        )
    if artifact is None:
        artifact = await artifact_by_port(project, port)

    if artifact is None:
        artifact = Artifact(
            name=name,
            kind=WEBAPP_KIND,
            description=description,
            project_id=project.id if project is not None else fallback_project_id,
            origin=origin,
            # The same provenance edge `register-artifact` stamps. Without it a
            # web app is absent from `artifacts`, which is a match on
            # `generated_by` — so "everything this run produced" silently
            # excluded every app the run built.
            generated_by=generated_by,
        )
        if project is not None:
            artifact.parent_type_id = str(project.typeid)
        await artifact.save()
    else:
        # Snapshot BEFORE mutating so a re-registration that changed nothing
        # writes nothing. `Artifact.register` guards the same way and for the
        # same reason: a save costs a SQL UPDATE, a WS broadcast to every
        # connected client and a metadata write, and an app can be
        # re-registered on every turn.
        fields = {"name", "kind", "description", "origin", "project_id", "generated_by", "parent_type_id"}
        before = artifact.model_dump(mode="json", include=fields)
        artifact.name = name
        artifact.kind = WEBAPP_KIND
        artifact.description = description
        artifact.origin = origin
        if project is not None:
            artifact.project_id = project.id
            artifact.parent_type_id = str(project.typeid)
        if not artifact.generated_by:
            artifact.generated_by = generated_by
        if artifact.model_dump(mode="json", include=fields) != before:
            await artifact.save()

    if project is not None:
        await project.attach_child(artifact)
        if artifact.id not in (project.artifacts or []):
            project.artifacts = list(project.artifacts or []) + [artifact.id]
            await project.save()
    return artifact


async def upsert_deployment(
    artifact,
    *,
    port: int,
    name: str,
    start_cmd: str,
    health: str,
    project,
) -> Optional[Any]:
    """Create/update the app's runtime placement — a local dev server.

    The row converges through ``Deployment.find_existing`` on (parent,
    provider) — re-registering the same app updates it rather than forking a
    second one, without baking the artifact id into an id that could then
    never change.

    Parented to the PROJECT, not the Artifact: an Artifact records how the app
    was generated and lives under its own parent, while the placement belongs
    to the project that owns the running thing. ``artifact_id`` keeps the
    reference.
    """
    from flow_sdk.builtin.deployment import KIND_WEB, Deployment  # noqa: PLC0415
    from flow_sdk.builtin.faas.compute_node import ComputeNode  # noqa: PLC0415

    if project is None:
        # Nothing to parent to, and a placement with no owner is not a
        # placement — the caller's project resolution already tried three ways
        # to find one.
        return None
    deployment = await Deployment.upsert(
        parent_type_id=str(project.typeid),
        provider="local",
        kind=KIND_WEB,
        element=project,
        payload={
            "name": f"{name} (local)",
            "artifact_id": artifact.id,
            "artifact_link_source": "manual",
            "target": {
                "provider": "local",
                "scope": project.id,
                "location": f"http://localhost:{port}",
            },
            "origin": {
                "kind": "local",
                "provider": "local",
                "external_id": ComputeNode._local_id(),
                "url": f"http://localhost:{port}",
            },
            "status": {"sync_state": "current", "provider_state": "configured"},
            "provider_labels": {
                "flowpad.runtime.port": str(port),
                "flowpad.runtime.start_cmd": start_cmd,
                "flowpad.runtime.health": health,
            },
            # The artifact already carries the origin this registration
            # resolved; a git one has a head_commit, a local one has none.
            "source_revision": getattr(artifact.origin, "head_commit", None),
            "project_id": project.id,
        },
    )
    await project.attach_child(deployment)
    return deployment


async def upsert_micro_app(
    artifact,
    *,
    artifact_path: str,
    name: str,
    dist: object,
    project,
    fallback_project_id: str | None = None,
) -> Optional[Any]:
    """Create/update the Artifact's delivery companion when built output exists.

    Returns ``None`` when the app has no build output yet — a dev-server-only
    app is a complete, valid app, so absence is the normal early state and not
    an error.
    """
    from flow_sdk.builtin.faas.micro_app import MicroApp  # noqa: PLC0415
    from flow_sdk.schema.data_spec.app_location_type import AppLocationType  # noqa: PLC0415

    app_root = Path(artifact_path)
    dist_rel = str(dist or "").strip()
    if dist_rel:
        dist_path = app_root / dist_rel
    else:
        dist_path = next((app_root / c for c in BUILD_OUTPUT_DIRS if (app_root / c).is_dir()), None)
        # A static app has no build step — the registered folder IS the
        # deliverable, and discovery points at whichever directory holds
        # index.html. Without this, exactly the apps that are ready to serve
        # with no work at all would be the ones that never get a delivery
        # companion.
        if dist_path is None and (app_root / "index.html").is_file():
            dist_path = app_root
    if dist_path is None:
        return None

    # LOOKUP, not an id derived from the artifact's: the row's natural key is
    # the artifact it delivers. Same idempotency on re-registration, and it
    # also finds rows minted before the convention existed.
    micro_app = await MicroApp.get_by_artifact_id(artifact.id)
    payload = {
        "name": name,
        "location_type": AppLocationType.Artifact,
        "location_root": str(dist_path),
        "artifact_id": artifact.id,
        "project_id": project.id if project is not None else fallback_project_id,
        "parent_type_id": str(project.typeid) if project is not None else None,
    }
    if micro_app is None:
        micro_app = MicroApp(**payload)
    else:
        micro_app.apply_field_updates(payload)
    await micro_app.save()
    if project is not None:
        await project.attach_child(micro_app)
    return micro_app


__all__ = [
    "BUILD_OUTPUT_DIRS",
    "artifact_by_port",
    "project_artifacts",
    "project_deployments",
    "upsert_artifact",
    "upsert_deployment",
    "upsert_micro_app",
]
