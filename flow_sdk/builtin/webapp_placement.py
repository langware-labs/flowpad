"""A registered web app's placement, and what that placement exposes.

An app is one thing in three planes: the **Artifact** records the source a run
produced, the **Deployment** records where it runs, and its **ServiceEndpoint**
rows record what that placement answers on — a ``proxy`` endpoint for a dev
server on a port, a ``static`` one for built output FlowPad serves itself. Every
endpoint references the artifact it serves, so re-registering updates rather
than forks.

A project has ONE local web placement; each of its apps is endpoints of it.
(``MicroApp`` used to be the delivery plane for built output. It is now the
DEFINITION of a webapp asset — ``webapp.json`` — and new registrations create no
delivery row; :func:`converge_legacy_web_rows` gives the old ones endpoints.)

This module owns only the payload shapes. Convergence itself belongs to the
entities — ``Deployment.upsert`` and endpoint lookups by natural key — and the
placement of an app was never a fact about the agentic process that happened
to build it, which is why none of this is a method on one.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any, Optional

from flow_sdk.schema.data_spec.service_endpoint_spec import PROTOCOL_WEB_APP
from flow_sdk.schema.data_spec.webapp_spec import WEBAPP_KIND, effective_endpoints

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
    """The project's web artifact currently served on ``port``, or None.

    The last of the three addresses a re-registration may arrive with, and the
    only one that is not a fact about the Artifact: a port belongs to the
    runtime placement — its ``proxy`` endpoint — so the match runs over the
    project's endpoints and comes back to the artifact they serve. An app moved
    to a new folder but still served on the same port converges here.
    """
    from flow_sdk.builtin.artifact import Artifact  # noqa: PLC0415

    if not port:
        return None
    try:
        wanted = int(str(port))
    except (TypeError, ValueError):
        return None
    for endpoint in await project_endpoints(project):
        if endpoint.backend.type == "proxy" and endpoint.backend.port == wanted and endpoint.artifact_id:
            return await Artifact.get_by_id(endpoint.artifact_id)
    return None


async def project_endpoints(project) -> list:
    """Every endpoint of this project's local web placements."""
    from flow_sdk.builtin.service_endpoint import ServiceEndpoint  # noqa: PLC0415

    endpoints: list = []
    for deployment in await project_deployments(project):
        endpoints += await ServiceEndpoint.of_deployment(str(deployment.typeid))
    return endpoints


async def artifact_endpoints(artifact_id: str) -> list:
    """The endpoints serving *artifact_id*, on any placement this machine knows."""
    from flow_sdk.builtin.service_endpoint import ServiceEndpoint  # noqa: PLC0415

    if not artifact_id:
        return []
    return await ServiceEndpoint.get_all({"match": {"artifact_id": str(artifact_id)}})


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


async def local_web_deployment(project, *, artifact, name: str) -> Optional[Any]:
    """The project's local web placement — created when missing, converged when present.

    Parented to the PROJECT, not the Artifact: an Artifact records how an app was
    generated and lives under its own parent, while the placement belongs to the
    project that owns the running thing. It carries no port: ports belong to the
    endpoints it exposes. ``artifact_id`` names the app registered most recently.
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
            "target": {"provider": "local", "scope": project.id},
            "origin": {"kind": "local", "provider": "local", "external_id": ComputeNode._local_id()},
            "status": {"sync_state": "current", "provider_state": "configured"},
            "provider_labels": {},
            # The artifact already carries the origin this registration
            # resolved; a git one has a head_commit, a local one has none.
            "source_revision": getattr(artifact.origin, "head_commit", None),
            "project_id": project.id,
        },
    )
    await project.attach_child(deployment)
    return deployment


_ENDPOINT_FIELDS = {"parent_type_id", "name", "protocol", "backend", "supports_direct_access", "artifact_id", "project_id"}


async def upsert_endpoint(
    parent_type_id: str,
    *,
    name: str,
    backend: dict,
    protocol: Optional[dict] = None,
    artifact_id: Optional[str] = None,
    project_id: Optional[str] = None,
    supports_direct_access: bool = False,
    existing: Optional[Any] = None,
) -> tuple[Any, bool]:
    """Write one endpoint of the placement *parent_type_id*, at *existing*'s id when there is one.

    Returns ``(row, saved)``. A no-op when nothing changed: an app is
    re-registered on every turn, and a save costs an UPDATE, a broadcast and a
    metadata write. The caller that holds the placement attaches a saved row.
    """
    from flow_sdk.builtin.service_endpoint import ServiceEndpoint  # noqa: PLC0415

    fresh = ServiceEndpoint(
        **({"id": existing.id} if existing is not None else {}),
        parent_type_id=str(parent_type_id),
        name=name,
        protocol=protocol or {"spec_kind": PROTOCOL_WEB_APP},
        backend=backend,
        supports_direct_access=supports_direct_access,
        artifact_id=artifact_id,
        project_id=project_id,
    )
    if existing is not None and existing.model_dump(mode="json", include=_ENDPOINT_FIELDS) == fresh.model_dump(
        mode="json", include=_ENDPOINT_FIELDS
    ):
        return existing, False
    await fresh.save()
    return fresh, True


async def upsert_artifact_endpoints(deployment, artifact, backends: list[tuple[str, dict]], *, project_id) -> list:
    """The artifact's endpoints on *deployment* — at most one per backend type, keyed by that pair.

    ``backends`` is ``[(name, backend), ...]``. The artifact's existing rows are
    read once for all of them. A ``static`` root is also written to a legacy
    delivery row of the same artifact, so ``/micro_app/<id>/view`` keeps serving
    what the endpoint serves without a lookup per file.
    """
    placement = str(deployment.typeid)
    existing = {e.backend.type: e for e in await artifact_endpoints(artifact.id) if e.parent_type_id == placement}
    rows = []
    for name, backend in backends:
        row, saved = await upsert_endpoint(
            placement,
            name=name,
            backend=backend,
            artifact_id=artifact.id,
            project_id=project_id,
            existing=existing.get(backend["type"]),
        )
        if saved:
            await deployment.attach_child(row)
            if backend["type"] == "static":
                await _repoint_legacy_delivery(artifact.id, backend["root"])
        rows.append(row)
    return rows


async def _repoint_legacy_delivery(artifact_id: str, root: str) -> None:
    from flow_sdk.builtin.faas.micro_app import MicroApp  # noqa: PLC0415

    legacy = await MicroApp.get_by_artifact_id(artifact_id)
    if legacy is not None and legacy.location_root != root:
        legacy.location_root = root
        await legacy.save()


def served_dir(artifact_path: str, dist: object) -> Optional[Path]:
    """The folder an app's built output is served from, or None when there is none yet.

    An app with no build output yet is a complete, valid app (a dev server), so
    absence is the normal early state and not an error. A static app has no
    build step — the registered folder IS the deliverable — which is why a folder
    holding ``index.html`` counts.
    """
    app_root = Path(artifact_path)
    dist_rel = str(dist or "").strip()
    if dist_rel:
        return app_root / dist_rel
    found = next((app_root / c for c in BUILD_OUTPUT_DIRS if (app_root / c).is_dir()), None)
    if found is None and (app_root / "index.html").is_file():
        found = app_root
    return found


async def upsert_micro_app(
    artifact,
    *,
    artifact_path: str,
    name: str,
    dist: object,
    project,
    fallback_project_id: str | None = None,
) -> Optional[Any]:
    """LEGACY: a delivery row for an app that has no project to place it in.

    Everything with a project is served by its placement's static endpoint; an
    app registered with no project at all has no placement to hang one on, so it
    keeps the old delivery row. Returns ``None`` when there is no build output.
    """
    from flow_sdk.builtin.faas.micro_app import MicroApp  # noqa: PLC0415
    from flow_sdk.schema.data_spec.app_location_type import AppLocationType  # noqa: PLC0415

    dist_path = served_dir(artifact_path, dist)
    if dist_path is None:
        return None
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


# ── a placement elsewhere: what a box exposes ───────────────────────────────


async def expose_project_endpoints(project, deployment_typeid: str) -> list:
    """Bring up every webapp asset of *project* as endpoints of *deployment_typeid*.

    Run on the machine a placement landed on (a cloud box, asked by the hub). Each
    app's ``webapp.json`` says what it exposes (``endpoints``); an app that says
    nothing exposes its ``build`` folder as a ``web.app``. A ``proxy`` entry is
    started on a loopback port here — the port it already has when re-exposed,
    so a second call does not start a second server. The rows are minted HERE
    and keyed by the hub's placement (which this machine does not hold), so the
    ids the hub adopts are these ids.
    """
    from flow_sdk.builtin.faas.micro_app import MicroApp  # noqa: PLC0415
    from flow_sdk.builtin.service_endpoint import ServiceEndpoint  # noqa: PLC0415
    from flow_sdk.schema.data_spec.app_location_type import AppLocationType  # noqa: PLC0415

    apps, current = await asyncio.gather(
        MicroApp.get_all({"match": {"project_id": project.id}}),
        ServiceEndpoint.of_deployment(deployment_typeid),
    )
    by_name = {endpoint.name: endpoint for endpoint in current}
    exposed: list = []
    for app in apps:
        if app.location_type != AppLocationType.Asset or not app.asset_ref:
            continue
        declared = list(app.endpoints or [])
        for spec in effective_endpoints(app.name, declared):
            name = f"{app.name}-{spec.name}" if declared else app.name
            existing = by_name.get(name)
            backend = await _placed_backend(app, spec, existing)
            row, _saved = await upsert_endpoint(
                deployment_typeid,
                name=name,
                backend=backend,
                protocol=spec.model_dump(mode="json")["protocol"],
                project_id=project.id,
                supports_direct_access=spec.supports_direct_access,
                existing=existing,
            )
            exposed.append(row)
    return exposed


async def _placed_backend(app, spec, existing) -> dict:
    """A manifest entry's serving template, made concrete on this machine."""
    from flow_sdk.core import dev_server  # noqa: PLC0415

    folder = Path(app.asset_ref)
    serving = spec.serving
    if serving.type == "static":
        return {"type": "static", "root": str(folder / (serving.root or app.build or "."))}
    placed = existing.backend.port if existing is not None and existing.backend.type == "proxy" else None
    port = serving.port or placed or await asyncio.to_thread(dev_server.find_free_port)
    command = serving.start_cmd.replace("{port}", str(port))
    if not await asyncio.to_thread(dev_server.port_open, port):
        await asyncio.to_thread(dev_server.start_detached, command, cwd=folder, port=port, name=app.name)
    return {"type": "proxy", "port": port, "start_cmd": command, "health": serving.health}


# ── rows written before endpoints existed ───────────────────────────────────

_LEGACY_LABELS = ("flowpad.runtime.port", "flowpad.runtime.start_cmd", "flowpad.runtime.health")


async def converge_legacy_web_rows() -> dict:
    """Give rows written before endpoints existed the endpoints they imply. Idempotent.

    * a local web Deployment still carrying ``flowpad.runtime.port`` gets its
      ``proxy`` endpoint, and the labels go;
    * a MicroApp delivering an Artifact's build output gets that output as a
      ``static`` endpoint of the project's placement. The row itself stays —
      ``/dock/app/micro_app-<id>`` links point at it, and history is forever.

    A converged row does no work on the next boot: the labels are gone, and an
    artifact that already has a ``static`` endpoint is skipped before any read.
    """
    from flow_sdk.builtin.artifact import Artifact  # noqa: PLC0415
    from flow_sdk.builtin.deployment import KIND_WEB, Deployment  # noqa: PLC0415
    from flow_sdk.builtin.faas.micro_app import MicroApp  # noqa: PLC0415
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.builtin.service_endpoint import ServiceEndpoint  # noqa: PLC0415
    from flow_sdk.core import QueryFilter  # noqa: PLC0415
    from flow_sdk.schema.data_spec.app_location_type import AppLocationType  # noqa: PLC0415
    from flow_sdk.worldview.ontology import kind_matches  # noqa: PLC0415

    counts = {"dev": 0, "served": 0}
    # By type, then kind_matches: a row refined to `runtime.web.vite` is still the web runtime.
    deployments, legacy_apps, endpoints = await asyncio.gather(
        Deployment.get_all(QueryFilter.by_type(Deployment.get_type())),
        MicroApp.get_all({"match": {"location_type": AppLocationType.Artifact.value}}),
        ServiceEndpoint.get_all(QueryFilter.by_type(ServiceEndpoint.get_type())),
    )
    for deployment in deployments:
        labels = dict(deployment.provider_labels or {})
        if not kind_matches(KIND_WEB, deployment.kind) or "flowpad.runtime.port" not in labels:
            continue
        try:
            port = int(labels["flowpad.runtime.port"])
        except (TypeError, ValueError):
            port = 0
        artifact = await Artifact.get_by_id(deployment.artifact_id) if deployment.artifact_id else None
        if artifact is not None and 0 < port <= 65535:
            backend = {
                "type": "proxy",
                "port": port,
                "start_cmd": labels.get("flowpad.runtime.start_cmd") or None,
                "health": labels.get("flowpad.runtime.health") or "/",
            }
            name = f"{artifact.name or 'app'}-dev"
            await upsert_artifact_endpoints(deployment, artifact, [(name, backend)], project_id=deployment.project_id)
            counts["dev"] += 1
        deployment.provider_labels = {k: v for k, v in labels.items() if k not in _LEGACY_LABELS}
        await deployment.save()

    served = {e.artifact_id for e in endpoints if e.artifact_id and e.backend.type == "static"}
    for app in legacy_apps:
        if not (app.artifact_id and app.project_id and app.location_root) or app.artifact_id in served:
            continue
        project, artifact = await asyncio.gather(Project.get_by_id(app.project_id), Artifact.get_by_id(app.artifact_id))
        if project is None or artifact is None:
            continue
        name = artifact.name or app.name
        deployment = await local_web_deployment(project, artifact=artifact, name=name)
        backend = {"type": "static", "root": app.location_root}
        await upsert_artifact_endpoints(deployment, artifact, [(name, backend)], project_id=project.id)
        served.add(app.artifact_id)
        counts["served"] += 1
    return counts


__all__ = [
    "BUILD_OUTPUT_DIRS",
    "artifact_by_port",
    "artifact_endpoints",
    "converge_legacy_web_rows",
    "expose_project_endpoints",
    "local_web_deployment",
    "project_artifacts",
    "project_deployments",
    "project_endpoints",
    "served_dir",
    "upsert_artifact",
    "upsert_artifact_endpoints",
    "upsert_endpoint",
    "upsert_micro_app",
]
