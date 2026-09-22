"""A registered web app's placement, and what that placement exposes.

An app is one thing in three planes: the **Artifact** records the source a run
produced, the **Deployment** records where it runs, and its **ServiceEndpoint**
rows record what that placement answers on — a ``proxy`` endpoint for a dev
server on a port, a ``static`` one for built output FlowPad serves itself. Every
endpoint references the artifact it serves, so re-registering updates rather
than forks.

A project has ONE local web placement; everything it serves is an endpoint of
it: a registered app's dev server and build, a bare dev server shown by port
(:func:`register_dev_endpoint`), and every webapp asset of the project
(:func:`place_webapp_locally`, run when the asset is indexed).

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


async def local_web_deployment(project, *, artifact=None) -> Optional[Any]:
    """The local web placement of *project* — or of this machine, for what has no project.

    Parented to the PROJECT, not the Artifact: an Artifact records how an app was
    generated and lives under its own parent, while the placement belongs to the
    project that owns the running thing. Something served here that belongs to no
    project (a user-scope webapp, a dev server a project-less run started) is the
    MACHINE's: its placement hangs off the local compute node. A placement carries
    no port — ports belong to the endpoints it exposes. ``artifact_id`` names the
    app registered most recently; placing anything else leaves it alone.
    """
    from flow_sdk.builtin.deployment import KIND_WEB, Deployment  # noqa: PLC0415
    from flow_sdk.builtin.faas.compute_node import ComputeNode  # noqa: PLC0415

    local_id = ComputeNode._local_id()
    owner = project if project is not None else await ComputeNode.get_by_id(local_id)
    if owner is None:
        return None
    payload: dict = {
        "name": f"{project.name or 'project'} (local)" if project is not None else "This machine",
        "target": {"provider": "local", "scope": project.id if project is not None else local_id},
        "origin": {"kind": "local", "provider": "local", "external_id": local_id},
        "status": {"sync_state": "current", "provider_state": "configured"},
        "provider_labels": {},
        "project_id": project.id if project is not None else None,
    }
    if artifact is not None:
        # The artifact already carries the origin this registration resolved; a
        # git one has a head_commit, a local one has none.
        payload |= {
            "artifact_id": artifact.id,
            "artifact_link_source": "manual",
            "source_revision": getattr(artifact.origin, "head_commit", None),
        }
    deployment = await Deployment.upsert(
        parent_type_id=str(owner.typeid), provider="local", kind=KIND_WEB, element=owner, payload=payload
    )
    await owner.attach_child(deployment)
    return deployment


_ENDPOINT_FIELDS = {
    "parent_type_id",
    "name",
    "protocol",
    "backend",
    "supports_direct_access",
    "artifact_id",
    "webapp_id",
    "project_id",
}


def _endpoint(
    parent_type_id: str,
    *,
    name: str,
    backend: dict,
    protocol: Optional[dict] = None,
    artifact_id: Optional[str] = None,
    webapp_id: Optional[str] = None,
    project_id: Optional[str] = None,
    supports_direct_access: bool = False,
    existing: Optional[Any] = None,
):
    """The endpoint row these fields describe, at *existing*'s id when there is one."""
    from flow_sdk.builtin.service_endpoint import ServiceEndpoint  # noqa: PLC0415

    return ServiceEndpoint(
        **({"id": existing.id} if existing is not None else {}),
        parent_type_id=str(parent_type_id),
        name=name,
        protocol=protocol or {"spec_kind": PROTOCOL_WEB_APP},
        backend=backend,
        supports_direct_access=supports_direct_access,
        artifact_id=artifact_id,
        webapp_id=webapp_id,
        project_id=project_id,
    )


def _unchanged(existing, fresh) -> bool:
    return existing is not None and existing.model_dump(mode="json", include=_ENDPOINT_FIELDS) == fresh.model_dump(
        mode="json", include=_ENDPOINT_FIELDS
    )


async def upsert_endpoint(deployment, *, existing: Optional[Any] = None, **fields) -> tuple[Any, bool]:
    """Write one endpoint of *deployment*, at *existing*'s id when there is one. Returns ``(row, saved)``.

    A no-op when nothing changed: an app is re-registered on every turn, and a
    save costs an UPDATE, a broadcast and a metadata write. A saved row is
    attached to its placement.
    """
    fresh = _endpoint(str(deployment.typeid), existing=existing, **fields)
    if _unchanged(existing, fresh):
        return existing, False
    await fresh.save()
    await deployment.attach_child(fresh)
    return fresh, True


async def upsert_artifact_endpoints(deployment, artifact, backends: list[tuple[str, dict]], *, project_id) -> list:
    """The artifact's endpoints on *deployment* — at most one per backend type, keyed by that pair.

    ``backends`` is ``[(name, backend), ...]``. The artifact's existing rows are
    read once for all of them. A dev server is its own origin (HMR sockets,
    absolute ``/src/...`` paths), so a ``proxy`` endpoint supports direct access.
    """
    placement = str(deployment.typeid)
    existing = {e.backend.type: e for e in await artifact_endpoints(artifact.id) if e.parent_type_id == placement}
    rows = []
    changed = False
    for name, backend in backends:
        row, saved = await upsert_endpoint(
            deployment,
            name=name,
            backend=backend,
            artifact_id=artifact.id,
            project_id=project_id,
            supports_direct_access=backend["type"] == "proxy",
            existing=existing.get(backend["type"]),
        )
        changed = changed or saved
        rows.append(row)
    if changed:
        tell_hub(deployment)
    return rows


async def register_dev_endpoint(project, *, port: int, name: Optional[str] = None):
    """The ``proxy`` endpoint for a dev server on *port* of this machine — found, or registered.

    ``flow show webapp --port N`` shows a server nothing else describes; the
    endpoint is what gives it an identity the display can hold (the port is how
    it is reached today, not what it is). A server an app registration already
    placed is that app's endpoint, so showing its port shows the app's row.
    """
    from flow_sdk.builtin.service_endpoint import ServiceEndpoint  # noqa: PLC0415

    deployment = await local_web_deployment(project)
    if deployment is None:
        raise ValueError("this machine has no compute node to place a dev server on")
    local = [e for e in await ServiceEndpoint.of_deployment(str(deployment.typeid)) if not e.remote]
    existing = next((e for e in local if e.backend.type == "proxy" and e.backend.port == port), None)
    if existing is not None and (not name or existing.name == name):
        return existing
    backend = {"type": "proxy", "port": port, "health": "/"}
    if existing is not None:
        backend = existing.backend.model_dump(mode="json")
    row, saved = await upsert_endpoint(
        deployment,
        name=name or f"port-{port}",
        backend=backend,
        artifact_id=existing.artifact_id if existing is not None else None,
        project_id=project.id if project is not None else None,
        supports_direct_access=True,
        existing=existing,
    )
    if saved:
        tell_hub(deployment)
    return row


# ── webapp assets: indexed here, served here ────────────────────────────────


#: In-flight hub refreshes, held so a task is not collected mid-flight.
_TELLING: set = set()


def tell_hub(deployment) -> None:
    """On a box: ask the hub to re-read what this placement exposes. Best-effort, in the background.

    The hub is authoritative for a placement it made, and pulls rather than being
    pushed rows: it asks the box for the placement's endpoints and adopts them at
    the box's ids (``deployment/<id>/refresh-endpoints``) — which reads this box's
    database, so the caller must not hold its write lock while waiting (an index
    pass does). Only a box has a hub placement to refresh; a desktop's are its own.
    """
    task = asyncio.get_running_loop().create_task(_tell_hub(deployment))
    _TELLING.add(task)
    task.add_done_callback(_TELLING.discard)


async def _tell_hub(deployment) -> None:
    from flow_sdk.instance_settings.runtime import own_sandbox_id  # noqa: PLC0415

    if not await asyncio.to_thread(own_sandbox_id):
        return
    from flow_sdk.cloud_client.transport import hub_http  # noqa: PLC0415

    try:
        await hub_http.hub_post(deployment.get_type(), {}, deployment.id, "refresh-endpoints")
    except Exception:  # noqa: BLE001 — the endpoint serves here either way; the hub catches up on the next one
        _log.info("hub did not refresh the endpoints of %s", deployment.typeid, exc_info=True)


async def webapp_endpoints(webapp_id: str) -> list:
    """This machine's endpoints serving the webapp definition *webapp_id*."""
    from flow_sdk.builtin.service_endpoint import ServiceEndpoint  # noqa: PLC0415

    rows = await ServiceEndpoint.get_all({"match": {"webapp_id": str(webapp_id)}})
    return [row for row in rows if not row.remote]


def _app_specs(app) -> list[tuple[str, Any]]:
    """``(endpoint name, spec)`` for everything *app* exposes — its declared endpoints, or its build folder.

    One naming rule for both ways an app is placed (indexed here, exposed on a
    box), so the two converge on the same rows instead of serving one folder twice.
    """
    declared = list(app.endpoints or [])
    return [
        (f"{app.name}-{spec.name}" if declared else app.name, spec) for spec in effective_endpoints(app.name, declared)
    ]


def _static_backend(app, spec) -> dict:
    return {"type": "static", "root": str(Path(app.asset_ref) / (spec.serving.root or app.build or "."))}


async def place_webapp_locally(app) -> Optional[Any]:
    """The webapp asset's ``static`` endpoint on its project's local placement. Idempotent.

    Run when the asset is indexed, so every webapp on disk is displayable by its
    endpoint — one in no project is served by this machine's placement. Only the
    static one: its declared ``proxy`` endpoints are started where it is PLACED
    (:func:`expose_project_endpoints`), never on an index pass. An app that
    declares no static endpoint is still served from its build folder here.
    """
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.schema.data_spec.webapp_spec import WebappEndpointSpec  # noqa: PLC0415

    if not app.asset_ref:
        return None
    name, spec = next(
        ((name, spec) for name, spec in _app_specs(app) if spec.serving.type == "static"),
        (app.name, WebappEndpointSpec(name=app.name)),
    )
    fields = dict(
        name=name,
        backend=_static_backend(app, spec),
        protocol=spec.model_dump(mode="json")["protocol"],
        webapp_id=app.id,
        project_id=app.project_id or None,
        supports_direct_access=spec.supports_direct_access,
    )
    existing = next((e for e in await webapp_endpoints(app.id) if e.backend.type == "static"), None)
    if existing is not None and _unchanged(existing, _endpoint(existing.parent_type_id, existing=existing, **fields)):
        return existing  # the steady state: an index pass that changed nothing writes nothing
    project = await Project.get_by_id(app.project_id) if app.project_id else None
    deployment = await local_web_deployment(project)
    if deployment is None:
        return None
    row, saved = await upsert_endpoint(deployment, existing=existing, **fields)
    if saved:
        tell_hub(deployment)
    return row


async def unplace_webapp(webapp_id: str) -> None:
    """A removed webapp asset takes the endpoints that served it along."""
    for endpoint in await webapp_endpoints(webapp_id):
        await endpoint.delete()


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


# ── a placement elsewhere: what a box exposes ───────────────────────────────


async def adopt_project_placement(project, deployment_typeid: str):
    """On a box: this project's local web placement takes the HUB's id for it.

    The hub placed the project here and names its placement; the box already has
    (or now mints) its own local one. One placement, one id everywhere — so the
    row is re-keyed rather than translated at every read, the way
    ``agent_places.adopt_placement`` re-keys an agent's. Everything the box
    registers afterwards (a dev server shown by port, an app registration, an
    indexed webapp) lands on the hub's placement by the ordinary
    :func:`local_web_deployment` lookup.
    """
    from flow_sdk.builtin.deployment import Deployment  # noqa: PLC0415

    deployment_id = deployment_typeid.partition("-")[2]
    existing = await Deployment.get_by_id(deployment_id)
    if existing is not None:
        if existing.parent_type_id != str(project.typeid) or not existing.is_local:
            raise ValueError(f"{deployment_typeid} is not this project's placement on this machine")
        return existing
    adopted = await (await local_web_deployment(project)).rekey(deployment_id)
    await project.attach_child(adopted)
    return adopted


async def expose_project_endpoints(project, deployment_typeid: str) -> list:
    """Bring up every webapp asset of *project* on the hub's placement, and report ALL it serves.

    Run on the machine a placement landed on (a cloud box, asked by the hub).
    The project's local placement is first re-keyed to the hub's id
    (:func:`adopt_project_placement`). Each app's ``webapp.json`` then says what
    it exposes (``endpoints``); an app that says nothing exposes its ``build``
    folder as a ``web.app``. A ``proxy`` entry is started on a loopback port
    here — the port it already has when re-exposed, so a second call does not
    start a second server. The answer is every endpoint of the placement — the
    apps' and whatever was registered on the box (a dev server shown by port) —
    and the ids are the box's, which the hub adopts.
    """
    from flow_sdk.builtin.faas.micro_app import WebApp  # noqa: PLC0415
    from flow_sdk.builtin.service_endpoint import ServiceEndpoint  # noqa: PLC0415

    deployment = await adopt_project_placement(project, deployment_typeid)
    apps, current = await asyncio.gather(
        WebApp.get_all({"match": {"project_id": project.id}}),
        ServiceEndpoint.of_deployment(deployment_typeid),
    )
    by_name = {endpoint.name: endpoint for endpoint in current}
    for app in apps:
        if not app.asset_ref:
            continue
        for name, spec in _app_specs(app):
            existing = by_name.get(name)
            backend = await _placed_backend(app, spec, existing)
            await upsert_endpoint(
                deployment,
                name=name,
                backend=backend,
                protocol=spec.model_dump(mode="json")["protocol"],
                webapp_id=app.id,
                project_id=project.id,
                supports_direct_access=spec.supports_direct_access,
                existing=existing,
            )
    return await ServiceEndpoint.of_deployment(deployment_typeid)


async def _placed_backend(app, spec, existing) -> dict:
    """A manifest entry's serving template, made concrete on this machine."""
    from flow_sdk.core import dev_server  # noqa: PLC0415

    folder = Path(app.asset_ref)
    serving = spec.serving
    if serving.type == "static":
        return _static_backend(app, spec)
    placed = existing.backend.port if existing is not None and existing.backend.type == "proxy" else None
    port = serving.port or placed or await asyncio.to_thread(dev_server.find_free_port)
    command = serving.start_cmd.replace("{port}", str(port))
    if not await asyncio.to_thread(dev_server.port_open, port):
        await asyncio.to_thread(dev_server.start_detached, command, cwd=folder, port=port, name=app.name)
    return {"type": "proxy", "port": port, "start_cmd": command, "health": serving.health}


# ── rows written before endpoints existed ───────────────────────────────────


async def prune_delivery_rows() -> int:
    """Drop the ``micro_app`` rows that were an app's DELIVERY, not its definition.

    Before endpoints, serving an app's build meant a DB-only ``micro_app`` row
    naming the folder. What serves a build now is its placement's ``static``
    endpoint, written when the app is registered, so such a row is served by
    nothing and names nothing a definition carries. It has no folder, so the
    delete is the row alone.
    """
    from flow_sdk.builtin.faas.micro_app import WebApp  # noqa: PLC0415
    from flow_sdk.core import QueryFilter  # noqa: PLC0415

    stale = [app for app in await WebApp.get_all(QueryFilter.by_type(WebApp.get_type())) if not app.asset_ref]
    for app in stale:
        await app.delete()
    return len(stale)


__all__ = [
    "BUILD_OUTPUT_DIRS",
    "adopt_project_placement",
    "artifact_by_port",
    "artifact_endpoints",
    "expose_project_endpoints",
    "local_web_deployment",
    "place_webapp_locally",
    "project_artifacts",
    "project_deployments",
    "project_endpoints",
    "prune_delivery_rows",
    "register_dev_endpoint",
    "served_dir",
    "tell_hub",
    "upsert_artifact",
    "upsert_artifact_endpoints",
    "upsert_endpoint",
    "unplace_webapp",
    "webapp_endpoints",
]
