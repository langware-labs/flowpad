"""Where a project's web apps are served: its placement's two audience proxies, and their routes.

An app is one thing in three planes: the **Artifact** records the source a run
produced, the **Deployment** records where it runs, and the placement's
**ServiceEndpoint** rows record what it answers on.

A placement answers a browser on AT MOST TWO endpoints — its ``app`` proxy (the
project's end users) and its ``admin`` proxy (its operators). Each is ``routed``:
every web app served there is a ROUTE of one of them, under a mount — a registered
app's dev server and build, a bare dev server shown by port
(:func:`register_dev_endpoint`), and every webapp asset of the project
(:func:`place_webapp_locally`, run when the asset is indexed). An audience nothing
is served to has no endpoint. A project has ONE local web placement.

A route is addressed as ``(endpoint, mount)`` — :class:`Placed`. Routes are written
only through :func:`set_route` / :func:`drop_routes`, one writer at a time per
placement (a route change is a read-modify-write of the proxy's row).
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from flow_sdk.schema.data_spec.asset_setup_spec import LoadResult
from flow_sdk.schema.data_spec.service_endpoint_spec import PROTOCOL_WEB_APP, WEB_AUDIENCES, ServedRouteSpec
from flow_sdk.schema.data_spec.webapp_spec import WEBAPP_KIND, WebappMountSpec, effective_mounts
from flow_sdk.stream_inbox._locks import keyed_loop_lock, new_registry

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
    """This project's web runtime placements — the project's own (anywhere), or this machine's for none."""
    from flow_sdk.builtin.deployment import Deployment  # noqa: PLC0415
    from flow_sdk.core import QueryFilter  # noqa: PLC0415

    source = project.typeid if project is not None else None
    rows = await Deployment.get_all(QueryFilter.by_type(Deployment.get_type()), source_entity=source)
    return [row for row in rows if row.element_type == "project" or row.is_this_computer]


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
    for placed in await project_routes(project):
        if placed.backend.type == "proxy" and placed.backend.port == wanted and placed.artifact_id:
            return await Artifact.get_by_id(placed.artifact_id)
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


async def local_web_deployment(project, *, artifact=None) -> Optional[Any]:
    """The local web placement of *project* — or of this machine, for what has no project.

    Parented to the PROJECT, not the Artifact: an Artifact records how an app was
    generated and lives under its own parent, while the placement belongs to the
    project that owns the running thing. Something served here that belongs to no
    project (a user-scope webapp, a dev server a project-less run started) is the
    MACHINE's: it is served from this computer's own placement
    (``Deployment.this_computer``). A placement carries no port — ports belong to
    the endpoints it exposes. ``artifact_id`` names the app registered most
    recently; placing anything else leaves it alone.
    """
    from flow_sdk.builtin.deployment import Deployment  # noqa: PLC0415
    from flow_sdk.builtin.faas.compute_node import ComputeNode  # noqa: PLC0415

    local_id = ComputeNode._local_id()
    owner = project if project is not None else await ComputeNode.get_by_id(local_id)
    if owner is None:
        return None
    if project is None:
        await Deployment.this_computer()  # the machine's placement exists before it is upserted below
    payload: dict = {
        "name": f"{project.name or 'project'} (local)" if project is not None else "This computer",
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
        parent_type_id=str(owner.typeid), provider="local", element=owner, payload=payload
    )
    await owner.attach_child(deployment)
    return deployment


_ENDPOINT_FIELDS = {
    "parent_type_id",
    "name",
    "subkind",
    "check",
    "protocol",
    "backend",
    "supports_direct_access",
    "artifact_id",
    "webapp_id",
    "project_id",
}


def _has_process(backend: dict) -> bool:
    """Whether *backend* runs a process a browser at this machine could reach at its own address."""
    if backend.get("type") == "proxy":
        return True
    routes = backend.get("routes") if backend.get("type") == "routed" else None
    return any((route.get("backend") or {}).get("type") == "proxy" for route in (routes or {}).values())


def _endpoint(
    parent_type_id: str,
    *,
    name: str,
    backend: dict,
    protocol: Optional[dict] = None,
    subkind: Optional[str] = None,
    check: Optional[dict] = None,
    artifact_id: Optional[str] = None,
    webapp_id: Optional[str] = None,
    project_id: Optional[str] = None,
    existing: Optional[Any] = None,
):
    """The endpoint row these fields describe, at *existing*'s id when there is one.

    ``supports_direct_access`` is not a caller's to say: it is what the backend IS — a process on
    this machine has an address of its own, files and a channel do not. Whether that address is
    reachable from outside is the placement's provider's to know, and the hub applies it.
    """
    from flow_sdk.builtin.service_endpoint import ServiceEndpoint  # noqa: PLC0415
    from flow_sdk.schema.data_spec.service_endpoint_spec import default_subkind  # noqa: PLC0415

    protocol = protocol or {"spec_kind": PROTOCOL_WEB_APP}
    return ServiceEndpoint(
        **({"id": existing.id} if existing is not None else {}),
        parent_type_id=str(parent_type_id),
        name=name,
        subkind=subkind or default_subkind(str(protocol.get("spec_kind") or "")),
        protocol=protocol,
        check=check if check is not None else (existing.check if existing is not None else None),
        backend=backend,
        supports_direct_access=_has_process(backend),
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

    For an endpoint that is a row of its own — an agent's ``chat``, a service an app brings along.
    A web app is not: it is a route (:func:`set_route`). A no-op when nothing changed: a save costs
    an UPDATE, a broadcast and a metadata write. A saved row is attached to its placement.
    """
    fresh = _endpoint(str(deployment.typeid), existing=existing, **fields)
    if _unchanged(existing, fresh):
        return existing, False
    await fresh.save()
    await deployment.attach_child(fresh)
    return fresh, True


# ── routes: an app as it is served here ─────────────────────────────────────


@dataclass(frozen=True)
class Placed:
    """One app as it is served on a placement: the audience proxy, and the mount on it.

    What a display, a probe or a setup step holds for "the endpoint of this app". ``id`` is the
    PROXY's — the address is the pair, and :meth:`model_dump` carries both.
    """

    endpoint: Any
    mount: str

    @property
    def route(self):
        return self.endpoint.backend.routes[self.mount]

    @property
    def backend(self):
        return self.route.backend

    @property
    def webapp_id(self) -> Optional[str]:
        return self.route.webapp_id

    @property
    def artifact_id(self) -> Optional[str]:
        return self.route.artifact_id

    @property
    def id(self) -> str:
        return self.endpoint.id

    @property
    def typeid(self):
        return self.endpoint.typeid

    @property
    def name(self) -> str:
        return self.mount or self.endpoint.name

    @property
    def subkind(self) -> str:
        return self.endpoint.subkind

    @property
    def remote(self) -> bool:
        return bool(self.endpoint.remote)

    @property
    def project_id(self) -> Optional[str]:
        return self.endpoint.project_id

    @property
    def parent_type_id(self) -> Optional[str]:
        return self.endpoint.parent_type_id

    def spec(self) -> ServedRouteSpec:
        """The route as a caller reads it — the typed answer shape."""
        return ServedRouteSpec(
            id=self.endpoint.id,
            route=self.mount,
            name=self.name,
            subkind=self.subkind,
            parent_type_id=self.parent_type_id,
            project_id=self.project_id,
            protocol=self.endpoint.protocol,
            backend=self.backend,
            webapp_id=self.webapp_id,
            artifact_id=self.artifact_id,
        )

    def model_dump(self, **kwargs: Any) -> dict:
        return self.spec().model_dump(**{"mode": "json", **kwargs})


def _routes_of(endpoint) -> list[Placed]:
    if endpoint is None or endpoint.backend.type != "routed":
        return []
    return [Placed(endpoint, mount) for mount in endpoint.backend.routes]


async def audience_proxies() -> list:
    """Every audience proxy this machine serves — the ``admin`` and ``app`` endpoints of its placements."""
    from flow_sdk.builtin.service_endpoint import ServiceEndpoint  # noqa: PLC0415

    found = await asyncio.gather(*(ServiceEndpoint.get_all({"match": {"subkind": a}}) for a in WEB_AUDIENCES))
    return [row for rows in found for row in rows if not row.remote and row.backend.type == "routed"]


async def deployment_routes(deployment_typeid: str) -> list[Placed]:
    """Every route of one placement, over both its audience proxies."""
    from flow_sdk.builtin.service_endpoint import ServiceEndpoint  # noqa: PLC0415

    rows = await ServiceEndpoint.of_deployment(str(deployment_typeid))
    return [placed for row in rows if row.subkind in WEB_AUDIENCES for placed in _routes_of(row)]


async def project_routes(project) -> list[Placed]:
    """Every route of this project's local web placements."""
    routes: list[Placed] = []
    for deployment in await project_deployments(project):
        routes += await deployment_routes(str(deployment.typeid))
    return routes


async def served_routes() -> list[Placed]:
    """Every route this machine serves, over every audience proxy — for a caller that asks about many apps."""
    return [placed for proxy in await audience_proxies() for placed in _routes_of(proxy)]


async def webapp_routes(webapp_id: str) -> list[Placed]:
    """This machine's routes serving the webapp definition *webapp_id* — static before a process."""
    if not webapp_id:
        return []
    found = [p for p in await served_routes() if p.webapp_id == str(webapp_id)]
    return sorted(found, key=lambda p: p.backend.type != "static")


async def artifact_routes(artifact_id: str) -> list[Placed]:
    """This machine's routes serving *artifact_id*."""
    if not artifact_id:
        return []
    return [p for p in await served_routes() if p.artifact_id == str(artifact_id)]


_MOUNT_BAD = re.compile(r"[^A-Za-z0-9._~-]+")
#: One writer at a time per placement: a route change is a read-modify-write of the proxy's row.
_ROUTE_LOCKS = new_registry()


def mount_name(label: str) -> str:
    """*label* as one path segment — what a mount may be. Empty when nothing of it survives."""
    return _MOUNT_BAD.sub("-", str(label or "").strip()).strip("-._~")


def _mounts_for(label: str, owner_id: str, backend_type: str, declared: Optional[str] = None) -> list[str]:
    """Where a route may mount, best first: the declared path, the app's name, then names only it can hold."""
    base = mount_name(label)
    wanted = declared if declared is not None else base
    tried = [wanted, f"{base}-{owner_id[:8]}" if base else owner_id[:8], owner_id, f"{owner_id}-{backend_type}"]
    return list(dict.fromkeys(tried))


def _serves(route: dict, webapp_id: Optional[str], artifact_id: Optional[str], backend_type: str) -> bool:
    """Whether *route* is already this app's route of this backend type (a build, or a dev server)."""
    if (route.get("backend") or {}).get("type") != backend_type:
        return False
    if webapp_id or artifact_id:
        return route.get("webapp_id") == webapp_id and route.get("artifact_id") == artifact_id
    return not route.get("webapp_id") and not route.get("artifact_id")


async def _write_proxy(deployment, audience: str, routes: dict, existing, project_id) -> tuple[Optional[Any], bool]:
    """The ``audience`` proxy of *deployment* now serves exactly *routes* — or is gone, when it serves nothing."""
    if not routes:
        if existing is not None:
            await existing.delete()
        return None, existing is not None
    return await upsert_endpoint(
        deployment,
        name=audience,
        subkind=audience,
        backend={"type": "routed", "routes": routes},
        project_id=project_id if project_id is not None else getattr(existing, "project_id", None),
        existing=existing,
    )


async def set_route(
    deployment,
    *,
    mounts: list[str],
    backend: dict,
    audience: str = "app",
    explicit: bool = False,
    webapp_id: Optional[str] = None,
    artifact_id: Optional[str] = None,
    project_id: Optional[str] = None,
    replaces: Optional[Placed] = None,
) -> tuple[Placed, bool]:
    """Serve an app on *deployment*'s ``audience`` proxy. Returns ``(placed, saved)``.

    One route per ``(app, backend type)``: an app's build and its dev server are two routes, and
    re-serving either lands on the mount it already has — so a re-registration never moves an app.
    ``mounts`` are where it may mount, best first; ``explicit`` says the first is the AUTHOR's
    (``webapp.json`` ``path``) and wins over the mount it holds. A mount another app holds is never
    taken. The same route on the placement's OTHER audience goes (an app re-declared for the other one),
    and so does ``replaces`` — the route this one stands in for (a bare server re-shown under another name).
    """
    from flow_sdk.builtin.service_endpoint import ServiceEndpoint  # noqa: PLC0415

    if audience not in WEB_AUDIENCES:
        raise ValueError(f"{audience!r} is not a web audience ({', '.join(WEB_AUDIENCES)})")
    backend_type = str(backend["type"])
    placement = str(deployment.typeid)
    async with keyed_loop_lock(_ROUTE_LOCKS, placement):
        rows = [r for r in await ServiceEndpoint.of_deployment(placement) if r.backend.type == "routed"]
        proxies = {a: next((r for r in rows if r.subkind == a), None) for a in WEB_AUDIENCES}
        tables = {
            a: dict(proxy.backend.model_dump(mode="json")["routes"]) if proxy is not None else {}
            for a, proxy in proxies.items()
        }
        routes = tables[audience]
        if webapp_id or artifact_id:
            held = next((m for m, r in routes.items() if _serves(r, webapp_id, artifact_id, backend_type)), None)
        else:
            # A bare server has no identity but where it mounts: only that mount is "the same route".
            first = mounts[0]
            held = first if first in routes and _serves(routes[first], None, None, backend_type) else None
        mount = held
        if mount is None or (explicit and mount != mounts[0]):
            free = [m for m in mounts if m not in routes or _serves(routes[m], webapp_id, artifact_id, backend_type)]
            if not free:
                raise ValueError(f"no free mount on the {audience} proxy of {placement}: tried {mounts}")
            if held is not None and free[0] != held:
                routes.pop(held)
            mount = free[0]
        routes[mount] = {"backend": backend, "webapp_id": webapp_id, "artifact_id": artifact_id}
        if replaces is not None and (replaces.subkind, replaces.mount) != (audience, mount):
            tables[replaces.subkind].pop(replaces.mount, None)
        saved = False
        for other in (a for a in WEB_AUDIENCES if a != audience):
            if webapp_id or artifact_id:
                tables[other] = {
                    m: r for m, r in tables[other].items() if not _serves(r, webapp_id, artifact_id, backend_type)
                }
            # Written only when it lost a route: the app moved here, or the replaced route was there.
            if proxies[other] is not None and len(tables[other]) != len(proxies[other].backend.routes):
                await _write_proxy(deployment, other, tables[other], proxies[other], project_id)
                saved = True
        row, wrote = await _write_proxy(deployment, audience, routes, proxies[audience], project_id)
    return Placed(row, mount), saved or wrote


async def drop_routes(
    *,
    webapp_id: Optional[str] = None,
    artifact_id: Optional[str] = None,
    backend_type: Optional[str] = None,
    keep: Optional[Placed] = None,
) -> int:
    """The routes of one app stop being served here (all of them, or those of one backend type).

    ``keep`` is the one route that stays — the app as it was just placed. A proxy left with no
    route is gone with its last one.
    """
    from flow_sdk.builtin.deployment import Deployment  # noqa: PLC0415
    from flow_sdk.builtin.service_endpoint import ServiceEndpoint  # noqa: PLC0415

    if not (webapp_id or artifact_id):
        return 0

    def gone(endpoint, mount: str, route: dict) -> bool:
        if keep is not None and endpoint.id == keep.id and mount == keep.mount:
            return False
        if webapp_id and route.get("webapp_id") != webapp_id:
            return False
        if artifact_id and route.get("artifact_id") != artifact_id:
            return False
        return backend_type is None or (route.get("backend") or {}).get("type") == backend_type

    dropped = 0
    for proxy in await audience_proxies():
        if not any(gone(proxy, m, r.model_dump(mode="json")) for m, r in proxy.backend.routes.items()):
            continue
        placement = str(proxy.parent_type_id or "")
        async with keyed_loop_lock(_ROUTE_LOCKS, placement):
            fresh = await ServiceEndpoint.get_by_id(proxy.id)
            if fresh is None or fresh.backend.type != "routed":
                continue
            routes = fresh.backend.model_dump(mode="json")["routes"]
            kept = {m: r for m, r in routes.items() if not gone(fresh, m, r)}
            if len(kept) == len(routes):
                continue
            dropped += len(routes) - len(kept)
            deployment = await Deployment.get_by_id(placement.partition("-")[2])
            if deployment is None or not kept:
                await fresh.delete()
            else:
                await _write_proxy(deployment, fresh.subkind, kept, fresh, fresh.project_id)
    return dropped


async def upsert_artifact_endpoints(
    deployment, artifact, backends: list[tuple[str, dict]], *, project_id, audience: str = "app"
) -> list[Placed]:
    """The artifact's routes on *deployment* — at most one per backend type (its dev server, its build).

    ``backends`` is ``[(name, backend), ...]``; the name is where the route would like to mount.
    A re-registration lands on the mounts the artifact already holds.
    """
    placed = []
    changed = False
    for name, backend in backends:
        row, saved = await set_route(
            deployment,
            audience=audience,
            mounts=_mounts_for(name, artifact.id, backend["type"]),
            backend=backend,
            artifact_id=artifact.id,
            project_id=project_id,
        )
        changed = changed or saved
        placed.append(row)
    if changed:
        tell_hub(deployment)
    return placed


async def register_dev_endpoint(project, *, port: int, name: Optional[str] = None, audience: str = "app") -> Placed:
    """The route for a dev server on *port* of this machine — found, or registered.

    ``flow show webapp --port N`` shows a server nothing else describes; the route is what gives it
    an address the display can hold (the port is how it is reached today, not what it is). A server
    an app registration already placed is that app's route, so showing its port shows the app.
    """
    deployment = await local_web_deployment(project)
    if deployment is None:
        raise ValueError("this machine has no compute node to place a dev server on")
    served = [p for p in await deployment_routes(str(deployment.typeid)) if p.backend.type == "proxy"]
    existing = next((p for p in served if p.backend.port == port and not p.remote), None)
    wanted = mount_name(name or "") or f"port-{port}"
    owned = existing is not None and bool(existing.webapp_id or existing.artifact_id)
    if owned and await _held_by_a_stranger(existing, port):
        # The route's port is a copy from when its app last ran. Another program on it now is not
        # that app: it is shown as the bare server it is, and the app's route is left alone.
        existing, owned = None, False
    if owned or (existing is not None and existing.subkind == audience and (not name or existing.mount == wanted)):
        return existing
    placed, saved = await set_route(
        deployment,
        audience=audience,
        mounts=list(dict.fromkeys([wanted, f"port-{port}", f"{wanted}-{port}"])),
        backend={"type": "proxy", "port": port, "start_cmd": None, "health": "/"},
        project_id=project.id if project is not None else None,
        # The same bare server, re-shown under another name or for the other audience: it is served once.
        replaces=existing,
    )
    if saved:
        tell_hub(deployment)
    return placed


async def _held_by_a_stranger(route: Placed, port: int) -> bool:
    """A program that is not the route's own app listens on ``port`` (``app_ports.stranger_on``)."""
    from flow_sdk.builtin.artifact import Artifact  # noqa: PLC0415
    from flow_sdk.builtin.faas.micro_app import WebApp  # noqa: PLC0415
    from flow_sdk.core import app_ports  # noqa: PLC0415

    owner = await WebApp.get_by_id(route.webapp_id) if route.webapp_id else await Artifact.get_by_id(route.artifact_id)
    folder = getattr(owner, "asset_ref", None) or getattr(owner, "path", None) if owner is not None else None
    if not folder:
        return False
    return await asyncio.to_thread(app_ports.stranger_on, port, Path(str(folder))) is not None


# ── webapp assets: indexed here, served here ────────────────────────────────


#: In-flight hub refreshes, held so a task is not collected mid-flight.
_TELLING: set = set()


def tell_hub(deployment) -> None:
    """On a box: ask the hub to re-read what this placement exposes. Best-effort, in the background.

    The hub is authoritative for a placement it made, and pulls rather than being
    pushed rows: it asks the box for the placement's endpoints and adopts them at
    the box's ids (``deployment/<id>/refresh-endpoints``) — which reads this box's
    database, so the caller must not hold its write lock while waiting (an index
    pass does). Only a box the hub placed (it was assigned a compute node) has a hub
    placement to refresh; a desktop's are its own.
    """
    task = asyncio.get_running_loop().create_task(_tell_hub(deployment))
    _TELLING.add(task)
    task.add_done_callback(_TELLING.discard)


async def _tell_hub(deployment) -> None:
    from flow_sdk.instance_settings.runtime import get_assigned_compute_node  # noqa: PLC0415

    if not get_assigned_compute_node():
        return
    from flow_sdk.cloud_client.transport import hub_http  # noqa: PLC0415

    try:
        await hub_http.hub_post(deployment.get_type(), {}, deployment.id, "refresh-endpoints")
    except Exception:  # noqa: BLE001 — the endpoint serves here either way; the hub catches up on the next one
        _log.info("hub did not refresh the endpoints of %s", deployment.typeid, exc_info=True)


def app_mounts(app) -> list[WebappMountSpec]:
    """How *app* is served to a web audience — its declared mounts, or the implicit static one.

    One rule for both ways an app is placed (indexed here, exposed on a box), so the two converge
    on the same routes instead of serving one folder twice.
    """
    return effective_mounts(list(app.mounts or []), list(app.services or []))


def _static_backend(app, mount) -> dict:
    return {"type": "static", "root": str(Path(app.asset_ref) / (mount.serving.root or app.build or "."))}


async def set_app_route(deployment, app, mount, backend: dict) -> tuple[Placed, bool]:
    """Serve *app* on *deployment* as its *mount* declares: that audience, at the author's path when they gave one."""
    return await set_route(
        deployment,
        audience=mount.audience,
        mounts=_mounts_for(app.name, str(app.id), str(backend["type"]), mount.path),
        explicit=mount.path is not None,
        backend=backend,
        webapp_id=str(app.id),
        project_id=app.project_id or None,
    )


async def place_webapp_locally(app) -> Optional[Placed]:
    """The webapp asset's ``static`` route on its project's local placement. Idempotent.

    Run when the asset is indexed, so every webapp on disk is displayable by its
    route — one in no project is served by this machine's placement. Only the
    static one: its declared ``proxy`` mounts are started where it is PLACED
    (:func:`expose_project_endpoints`), never on an index pass. An app that
    declares no static mount is still served from its build folder here.
    """
    from flow_sdk.builtin.project import Project  # noqa: PLC0415

    if not app.asset_ref:
        return None
    mount = next((m for m in app_mounts(app) if m.serving.type == "static"), None)
    # The folder is served as the app only when that IS the app: it declares no mounts, or it has a build
    # of its own. An app that declares only a dev server keeps SOURCE in its folder — serving that raw would
    # show a page that is not the app, and hide that the app is not running (the setup tree starts it).
    if mount is None and (app.mounts or app.services) and str(app.build or ".") in ("", "."):
        await drop_routes(webapp_id=str(app.id), backend_type="static")
        return None
    mount = mount or WebappMountSpec()  # an app with a build of its own is served from it, whatever it declares
    backend = _static_backend(app, mount)
    current = next((p for p in await webapp_routes(str(app.id)) if p.backend.type == "static"), None)
    if (
        current is not None
        and current.subkind == mount.audience
        and current.backend.model_dump(mode="json") == backend
        and current.project_id == (app.project_id or None)
        and (mount.path is None or current.mount == mount.path)
    ):
        return current  # the steady state: an index pass that changed nothing writes nothing
    project = await Project.get_by_id(app.project_id) if app.project_id else None
    deployment = await local_web_deployment(project)
    if deployment is None:
        return None
    placed, saved = await set_app_route(deployment, app, mount, backend)
    if current is not None and current.parent_type_id != placed.parent_type_id:
        # An app that moved to another project left its route on the placement it came from.
        await drop_routes(webapp_id=str(app.id), backend_type="static", keep=placed)
    if saved:
        tell_hub(deployment)
    return placed


async def show_webapp_locally(app, project=None) -> tuple[Optional[Placed], LoadResult]:
    """Showing a webapp asset here: its static route placed, then the app LOADED (``core/setup/load``).

    ``(placed, lifecycle)`` — the typed setup requirement, progress, readiness or failure.
    One call for every display path (the home page, ``flow show``), so none can
    place without loading. ``project``: the app's, when the caller holds it."""
    from flow_sdk.builtin.asset_publishing import owning_project  # noqa: PLC0415
    from flow_sdk.core.setup.load import load_asset  # noqa: PLC0415

    placed = await place_webapp_locally(app)
    project = project or await owning_project(app)
    lifecycle = await load_asset(project, app)
    return placed, lifecycle


async def unplace_webapp(webapp_id: str) -> None:
    """A removed webapp asset takes the routes that served it — and the services it brought — along."""
    from flow_sdk.builtin.service_endpoint import ServiceEndpoint  # noqa: PLC0415

    await drop_routes(webapp_id=str(webapp_id))
    for row in await ServiceEndpoint.get_all({"match": {"webapp_id": str(webapp_id)}}):
        if not row.remote:
            await row.delete()


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


async def _agent_placement(deployment_typeid: str):
    """The agent placement *deployment_typeid* names on this machine (running, with its ``chat``), or None.

    An agent deploy places the agent (re-keyed at ``adopt_placement``), not the
    project's web runtime — so its apps and its chat are endpoints of the AGENT's
    placement, and the project's web placement is left alone. On this machine it RUNS:
    ``serving``, so this machine's supervisor keeps its loop process up.
    """
    from flow_sdk.builtin.agent import Agent  # noqa: PLC0415
    from flow_sdk.builtin.agent_serve import ensure_chat_channel  # noqa: PLC0415
    from flow_sdk.builtin.deployment import Deployment  # noqa: PLC0415

    deployment = await Deployment.get_by_id(deployment_typeid.partition("-")[2])
    if deployment is None or not deployment.places_agent:
        return None
    agent = await Agent.get_by_id(str(deployment.parent_type_id or "").partition("-")[2])
    if agent is None or not deployment.is_local:
        raise ValueError(f"{deployment_typeid} is not an agent placement on this machine")
    if not deployment.serving:
        deployment.serving = True
        await deployment.save()
    await ensure_chat_channel(agent, deployment)
    return deployment


async def expose_project_endpoints(project, deployment_typeid: str) -> list:
    """Bring up every webapp asset of *project* on the hub's placement, and report ALL it serves.

    Run on the machine a placement landed on (a cloud box, asked by the hub).
    The project's local placement is first re-keyed to the hub's id
    (:func:`adopt_project_placement`). Each app's ``webapp.json`` then says how
    it is served (``mounts``) — an app that says nothing is its ``build`` folder,
    to the ``app`` audience — and each mount becomes a route of the placement's
    ``admin`` or ``app`` proxy. A ``proxy`` mount is started on a loopback port
    here — found running when re-exposed, so a second call does not start a
    second server. A service the app brings along (``services``) is an
    endpoint of its own. The answer is every endpoint of the placement — the two
    proxies, the services, an agent's chat — and the ids are the box's, which
    the hub adopts.
    """
    from flow_sdk.builtin.faas.micro_app import WebApp  # noqa: PLC0415
    from flow_sdk.builtin.service_endpoint import ServiceEndpoint  # noqa: PLC0415

    deployment = await _agent_placement(deployment_typeid) or await adopt_project_placement(project, deployment_typeid)
    apps = await WebApp.get_all({"match": {"project_id": project.id}})
    for app in apps:
        if not app.asset_ref:
            continue
        for mount in app_mounts(app):
            await set_app_route(deployment, app, mount, await _placed_backend(app, mount))
        for service in app.services or []:
            await set_service_endpoint(deployment, app, service, await _started(app, service.serving))
    return await ServiceEndpoint.of_deployment(deployment_typeid)


def service_endpoint_name(app, service) -> str:
    """The endpoint a service the app brings along is placed as: ``<app>-<service>``."""
    return f"{app.name}-{service.name}"


async def service_endpoint_ports(app) -> dict[str, Any]:
    """Each of the app's service endpoints here, by name: the port its backend names now (None for none)."""
    from flow_sdk.builtin.service_endpoint import ServiceEndpoint  # noqa: PLC0415

    rows = await ServiceEndpoint.get_all({"match": {"webapp_id": str(app.id)}})
    return {row.name: getattr(row.backend, "port", None) for row in rows}


async def set_service_endpoint(deployment, app, service, backend: dict) -> None:
    """A service the app brings along is an endpoint of its own on ``deployment``, named ``<app>-<name>``."""
    from flow_sdk.builtin.service_endpoint import ServiceEndpoint  # noqa: PLC0415

    name = service_endpoint_name(app, service)
    existing = next((row for row in await ServiceEndpoint.of_deployment(str(deployment.typeid)) if row.name == name), None)
    await upsert_endpoint(
        deployment,
        name=name,
        backend=backend,
        protocol=service.model_dump(mode="json")["protocol"],
        webapp_id=str(app.id),
        project_id=app.project_id,
        existing=existing,
    )


async def _placed_backend(app, mount) -> dict:
    """A mount's serving template, made concrete on this machine."""
    if mount.serving.type == "static":
        return _static_backend(app, mount)
    return await _started(app, mount.serving)


async def _started(app, serving) -> dict:
    """The process *serving* describes, running on a loopback port here. Which port, and whether what
    holds it is this app, is ``app_ports``' one rule (``webapp_setup.where``).

    Not waited for: the hub asks for a placement's endpoints and reads their health afterwards."""
    from flow_sdk.builtin import webapp_setup  # noqa: PLC0415
    from flow_sdk.core import dev_server  # noqa: PLC0415

    found = await webapp_setup.where(app, serving)
    command = serving.start_cmd.replace("{port}", str(found.port))
    if found.state == "start":
        await asyncio.to_thread(dev_server.start_detached, command, cwd=Path(app.asset_ref), port=found.port, name=app.name)
    elif found.state != "running":
        _log.warning("%s is not started here: %s", app.name, found.note)
    return {"type": "proxy", "port": found.port, "start_cmd": command, "health": serving.health}


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


async def prune_per_app_endpoints() -> int:
    """Drop the endpoint rows that were ONE web app each, and serve every webapp asset as a route again.

    Before the audience proxies, each app served on a placement was a ``web.app`` row of its own
    (``static`` or ``proxy``). A placement now answers a browser on its ``admin`` / ``app`` proxy,
    so such a row is served by nothing that addresses it. This machine's rows only — a hub row is
    the hub's. Each webapp asset on disk is then placed as the route it is; a dev server or a
    registered build returns when it is next shown or registered.
    """
    from flow_sdk.builtin.faas.micro_app import WebApp  # noqa: PLC0415
    from flow_sdk.builtin.service_endpoint import ServiceEndpoint  # noqa: PLC0415
    from flow_sdk.core import QueryFilter  # noqa: PLC0415

    rows = await ServiceEndpoint.get_all(QueryFilter.by_type(ServiceEndpoint.get_type()))
    stale = [
        row
        for row in rows
        if not row.remote and row.protocol.kind == PROTOCOL_WEB_APP and row.backend.type in ("static", "proxy")
    ]
    for row in stale:
        await row.delete()
    if stale:
        for app in await WebApp.get_all(QueryFilter.by_type(WebApp.get_type())):
            if app.asset_ref and app.on_disk():
                await place_webapp_locally(app)
    return len(stale)


__all__ = [
    "BUILD_OUTPUT_DIRS",
    "Placed",
    "adopt_project_placement",
    "app_mounts",
    "artifact_by_port",
    "artifact_routes",
    "audience_proxies",
    "deployment_routes",
    "drop_routes",
    "expose_project_endpoints",
    "local_web_deployment",
    "mount_name",
    "place_webapp_locally",
    "project_artifacts",
    "project_deployments",
    "project_routes",
    "prune_delivery_rows",
    "prune_per_app_endpoints",
    "register_dev_endpoint",
    "served_dir",
    "served_routes",
    "set_app_route",
    "set_route",
    "show_webapp_locally",
    "tell_hub",
    "upsert_artifact",
    "upsert_artifact_endpoints",
    "upsert_endpoint",
    "unplace_webapp",
    "webapp_routes",
]
