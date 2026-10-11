"""Check and recover an app's local presentation through the default load wizard.

Only the requested session's exact app entry is repaired. File existence is not
app readiness: a raw HTML display omits the endpoint identity the App SDK needs.
"""
from __future__ import annotations

from pathlib import Path

from flow_sdk.api.api_types.vfs_path import VFSPath
from flow_sdk.core.display_target import DisplayTargetKind, endpoint_target
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, ReturnedValue
from flow_sdk.schema.data_spec.service_endpoint_spec import PROTOCOL_WEB_APP
from flow_sdk.schema.types import EntityType


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


def _matches(endpoint, app, name, spec) -> bool:
    from flow_sdk.builtin.webapp_placement import _static_backend

    return (endpoint.name == name and endpoint.project_id == app.project_id
            and endpoint.protocol.spec_kind == PROTOCOL_WEB_APP
            and endpoint.backend.type == spec.serving.type
            and endpoint.protocol.entry == spec.protocol.entry
            and (spec.serving.type != "static"
                 or Path(endpoint.backend.root).resolve() == Path(_static_backend(app, spec)["root"]).resolve()))


async def present(app, *, display: str = "", check: bool) -> ReturnedValue:
    """Read-only completion check, or deterministic repair followed by that check.

The check deliberately claims only filesystem, placement and saved-target
readiness. JavaScript/render failures still belong to the viewer's diagnostics.
"""
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.builtin.project import Project
    from flow_sdk.builtin.service_endpoint import ServiceEndpoint
    from flow_sdk.builtin.webapp_placement import _app_specs, _static_backend, place_webapp_locally, webapp_endpoints

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

    specs = [(name, spec) for name, spec in _app_specs(app) if spec.protocol.spec_kind == PROTOCOL_WEB_APP]
    if not specs:
        return answer("no web.app presentation is declared; presentation check is not applicable", ok=True)
    entries: list[Path] = []
    endpoints = await webapp_endpoints(app.id)
    missing = []
    valid = set()
    for name, spec in specs:
        candidates = [e for e in endpoints if _matches(e, app, name, spec)]
        if spec.serving.type == "static":
            root = Path(_static_backend(app, spec)["root"]).resolve()
            entry = (root / spec.protocol.entry).resolve()
            if not entry.is_relative_to(root):
                return answer(f"entry {entry} escapes served root {root}")
            entries.append(entry)
            if not root.is_dir() or not entry.is_file():
                return answer(f"missing web.app entry {entry}")
        valid.update(e.id for e in candidates)
        if not candidates:
            missing.append(name)

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
        # A deleted endpoint has no ownership evidence: never guess which app it served.
        if endpoint is not None and endpoint.webapp_id == app.id:
            stale = endpoint.remote or endpoint.id not in valid

    if check:
        if missing:
            return answer(f"missing or outdated local endpoint: {', '.join(missing)}; target={target!r}")
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
        endpoints = await webapp_endpoints(app.id)
        endpoint = next((e for e in endpoints if any(_matches(e, app, name, spec) for name, spec in specs)), None)
        if endpoint is None:
            return answer("no local web.app endpoint after placement")
        await process.on_show({**endpoint_target(endpoint, name=app.title or app.name),
                               "typeid": str(app.typeid), "micro_app_id": app.id})
    result = await present(app, display=display, check=True)
    return result.model_copy(update={"ran": bool(missing or stale)})
