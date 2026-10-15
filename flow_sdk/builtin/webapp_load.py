"""Check and recover an app's local presentation through the default load wizard.

Only the requested session's exact app entry is repaired. File existence is not
app readiness: a raw HTML display omits the endpoint identity the App SDK needs.
"""
from __future__ import annotations

from pathlib import Path

from flow_sdk.api.api_types.vfs_path import VFSPath
from flow_sdk.builtin.faas.webapp_spec import VIEWER_KIND
from flow_sdk.core.display_target import DisplayTargetKind, endpoint_target
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, ReturnedValue
from flow_sdk.schema.data_spec.service_endpoint_spec import WebAppProtocol
from flow_sdk.schema.types import EntityType
from flow_sdk.worldview.ontology import kind_matches


def _entry_target(target: dict, entries: list[Path], project) -> bool:
    """Match canonical resource identities, never a path suffix or an app name."""
    from flow_sdk.builtin.faas.compute_node import ComputeNode

    if target.get("kind") != DisplayTargetKind.VFS or not isinstance(target.get("path"), str):
        return False
    raw = target["path"]
    if Path(raw).is_absolute():
        return Path(raw).resolve() in entries
    try:
        actual = VFSPath(raw)
    except ValueError:
        return False
    nodes = [TypeId(type=EntityType.COMPUTE_NODE, id=node) for node in ("@local", ComputeNode._local_id())]
    root = Path(project.fs_storage_mount_path).resolve() if project and project.fs_storage_mount_path else None
    for entry in entries:
        for node in nodes:
            if actual == VFSPath.from_machine_path(str(entry), node):
                return True
        if root is not None and entry.is_relative_to(root) and actual == VFSPath.from_entity_path(
            project.typeid, entry.relative_to(root).as_posix()
        ):
            return True
    return False


#: The document a browser opens first on a route — the audience proxy speaks ``web.app``.
ENTRY = WebAppProtocol().entry


def _matches(placed, app, mount) -> bool:
    """Whether *placed* is the route *mount* describes: this app's, on that audience, served that way."""
    from flow_sdk.builtin.webapp_placement import _static_backend

    return (placed.webapp_id == str(app.id) and placed.project_id == (app.project_id or None)
            and placed.subkind == mount.audience
            and placed.backend.type == mount.serving.type
            and (mount.path is None or placed.mount == mount.path)
            and (mount.serving.type != "static"
                 or Path(placed.backend.root).resolve() == Path(_static_backend(app, mount)["root"]).resolve()))


async def present(app, *, display: str = "", check: bool) -> ReturnedValue:
    """Read-only completion check, or deterministic repair followed by that check.

The check deliberately claims only filesystem, placement and saved-target
readiness. JavaScript/render failures still belong to the viewer's diagnostics.
"""
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.builtin.project import Project
    from flow_sdk.builtin.service_endpoint import ServiceEndpoint
    from flow_sdk.builtin.webapp_placement import _static_backend, app_mounts, place_webapp_locally, webapp_routes

    context = f"app={app.typeid}, display={display or '(none)'}"

    def answer(detail: str, *, ok: bool = False) -> ReturnedValue:
        return ReturnedValue(exit_code=ExitCode.OK if ok else ExitCode.NOT_YET,
                             detail=f"{context}: {detail}", ran=not check)

    if not app.asset_ref:
        return answer("the app has no local folder")
    process = None
    if display:
        try:
            identity = TypeId(display)
        except (ValueError, TypeError, IndexError):
            return answer("invalid display session identity")
        if identity.type != EntityType.AGENTIC_PROCESS:
            return answer("display must identify an agentic process")
        process = await AgenticProcess.get_by_id(identity.id)
        if process is None or not app.project_id or process.project_id != app.project_id:
            return answer("display session is missing or belongs to another project")

    if kind_matches(VIEWER_KIND, app.kind):
        # A viewer is a module a host page imports, not a page of its own: it has no index.html to serve,
        # so demanding one failed every shipped viewer. Its entry is its module.
        module = Path(app.asset_ref) / app.build / app.module.lstrip("/")
        if not module.is_file():
            return answer(f"missing viewer module {module}")
        return answer("a viewer module is presented by its host page", ok=True)
    mounts = app_mounts(app)
    if not mounts:
        return answer("no web presentation is declared; presentation check is not applicable", ok=True)
    entries: list[Path] = []
    placed = await webapp_routes(str(app.id))
    missing = []
    valid = set()
    for mount in mounts:
        candidates = [p for p in placed if _matches(p, app, mount)]
        if mount.serving.type == "static":
            root = Path(_static_backend(app, mount)["root"]).resolve()
            entry = (root / ENTRY).resolve()
            entries.append(entry)
            if not root.is_dir() or not entry.is_file():
                return answer(f"missing web.app entry {entry}")
        valid.update((p.id, p.mount) for p in candidates)
        if not candidates:
            missing.append(f"{mount.audience}:{mount.path if mount.path is not None else app.name}")

    target = (process.context_data or {}).get("last_shown") if process else None
    stale = False
    if isinstance(target, dict) and target.get("kind") == DisplayTargetKind.VFS:
        project = await Project.get_by_id(app.project_id) if app.project_id else None
        stale = _entry_target(target, entries, project)
    if isinstance(target, dict) and target.get("kind") == DisplayTargetKind.APP:
        endpoint_id = target.get("endpoint_id")
        if not endpoint_id and str(target.get("typeid", "")).startswith(f"{EntityType.SERVICE_ENDPOINT}-"):
            try:
                endpoint_id = TypeId(target["typeid"]).id
            except (ValueError, TypeError, IndexError):
                return answer(f"invalid saved endpoint identity: {target!r}")
        endpoint = await ServiceEndpoint.get_by_id(endpoint_id) if endpoint_id else None
        # A deleted endpoint, or a mount it no longer routes, has no ownership evidence: never guess
        # which app it served.
        mount = str(target.get("route") or "")
        shown = endpoint.route(mount) if endpoint is not None else None
        owned = target.get("micro_app_id") == str(app.id) or (shown is not None and shown.webapp_id == str(app.id))
        if endpoint is not None and owned:
            stale = endpoint.remote or (endpoint.id, mount) not in valid

    if check:
        if missing:
            return answer(f"missing or outdated local route: {', '.join(missing)}; target={target!r}")
        if stale:
            return answer(f"saved target bypasses the app's current local presentation: {target!r}")
        return answer("entry, local placement and saved presentation are ready", ok=True)

    if missing:
        await place_webapp_locally(app)
        verified = await present(app, check=True)
        if not verified.ok:
            return verified
    if stale and process is not None:
        # Do not steal a display the person changed while placement was repaired.
        fresh = await AgenticProcess.get_by_id(process.id)
        if fresh is None or (fresh.context_data or {}).get("last_shown") != target:
            return await present(app, display=display, check=True)
        process = fresh
        placed = await webapp_routes(str(app.id))
        route = next((p for p in placed if any(_matches(p, app, mount) for mount in mounts)), None)
        if route is None:
            return answer("no local web.app route after placement")
        await process.on_show({**endpoint_target(route, name=app.title or app.name),
                               "typeid": str(app.typeid), "micro_app_id": app.id})
    result = await present(app, display=display, check=True)
    return result.model_copy(update={"ran": bool(missing or stale)})
