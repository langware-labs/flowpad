"""``ProjectManifest`` — the ROW for a project's published-asset ledger.

Its shape on disk is ``ProjectManifestSpec`` (``TypeInfo.asset_spec``); the
file is written only through ``flow_sdk.assets.project_manifest`` and never
through ``Entity.save()`` — the row is a projection the indexer produces.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from flow_sdk.actions.action_registry import action as _action_registry
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.schema.data_spec.project_manifest_spec import PROJECT_MANIFEST_SCHEMA, PublishedAssetSpec, split_typeid
from flow_sdk.schema.types import EntityType

logger = logging.getLogger(__name__)


class ProjectManifest(Entity):
    """The ROW. One per project; the entity-type dir is the asset root."""

    type: str = APIField(default=EntityType.PROJECT_MANIFEST.value)

    # ── the ProjectManifestSpec fields, round-tripped through project_manifest.json ──
    manifest_schema: int = APIField(default=PROJECT_MANIFEST_SCHEMA)
    requires: dict[str, str] = APIField(default_factory=dict)
    entries: list[PublishedAssetSpec] = APIField(default_factory=list)
    asset_ref: str = APIField(default="")


# ── the desk layer: publish / unpublish / the read view ──────────────────────
#
# Everything below touches rows. The FILE is written only through
# ``flow_sdk.assets.project_manifest`` (pure, hub-importable); the hub gets the
# same read contract from its git tree without any of this.


class PublishRefused(ValueError):
    """A publish the caller can fix: wrong type, no carrier, no project, outside
    the project. ``code`` is the wire reason; the message is for a person."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


async def project_for_entity(entity: Entity, project_id: str | None):
    """The project whose manifest this asset publishes into: the caller's
    choice, else the ONE definition of "which project owns this asset" the
    git-publish path gates on (``owning_project``)."""
    from flow_sdk.assets._publish_service import owning_project  # noqa: PLC0415
    from flow_sdk.builtin.project import Project  # noqa: PLC0415

    if project_id:
        return await Project.get_one({"id": str(project_id)})
    return await owning_project(entity)


def _mount_of(project) -> Path | None:
    return Path(project.fs_storage_mount_path) if project is not None and project.fs_storage_mount_path else None


async def ensure_manifest_indexed(project) -> Entity | None:
    """Index the project's manifest (minting its sidecar id on first sight) so
    the row exists and the reconcile hook refreshes every ``published`` cache.
    None when the project has no manifest on disk."""
    from flow_sdk.assets.project_manifest import manifest_dir, manifest_path  # noqa: PLC0415
    from flow_sdk.fs_store.resolve import index_one, resolve_asset  # noqa: PLC0415

    mount = _mount_of(project)
    if mount is None or not manifest_path(mount).exists():
        return None
    resolved = await resolve_asset(manifest_dir(mount), write=True, type_name=EntityType.PROJECT_MANIFEST.value)
    await index_one(resolved, notify=True, scope="project", project_id=str(project.id))
    return await ProjectManifest.get_one({"id": resolved.id})


async def origin_for_asset(asset_ref: str):
    """WHERE a reader can fetch this asset: its repo's ``GitOrigin`` (repo,
    branch, commit, rel_path) when the checkout has a usable remote, else the
    ``LocalOrigin`` of the asset root — enough for a reader on this machine and
    honestly ``missing`` for anyone else. Blocking git reads run in a thread."""
    from flow_sdk.fs_store.origin.git_origin import GitOrigin  # noqa: PLC0415
    from flow_sdk.fs_store.origin.local_origin import local_origin_for_path  # noqa: PLC0415

    try:
        origin = await asyncio.to_thread(GitOrigin.for_asset_path, str(asset_ref))
    except Exception:  # noqa: BLE001 — a broken checkout is not a publish failure
        origin = None
    return origin or local_origin_for_path(asset_ref)


async def set_published(entity: Entity, *, published: bool, project_id: str | None = None) -> Entity:
    """The whole verb. Publish = make sure the asset carries its id, then write
    the row; unpublish = drop the row. Either way the manifest is re-indexed so
    the ``published`` cache on this row follows the file. Returns the canonical
    row (re-read after the reconcile)."""
    from flow_sdk.assets.project_manifest import make_entry, publish, rel_path_for  # noqa: PLC0415
    from flow_sdk.fs_store.fs_ref import FSRef  # noqa: PLC0415
    from flow_sdk.fs_store.identity_carrier import ForeignId, NotWritable  # noqa: PLC0415
    from flow_sdk.fs_store.resolve import index_one, resolve_asset  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
    from flow_sdk.schema.data_spec.project_manifest_spec import PUBLISHABLE_TYPES  # noqa: PLC0415

    type_name = entity.get_type()
    if type_name not in PUBLISHABLE_TYPES:
        raise PublishRefused("not_publishable", f"a {type_name} cannot be published")
    if entity.scope == "system":
        raise PublishRefused("system_asset", "system assets are not a project's to publish")
    asset_ref = str(entity.asset_ref or "")
    if not asset_ref or not Path(asset_ref).exists():
        raise PublishRefused("no_carrier", "this asset has no file to carry its id")

    project = await project_for_entity(entity, project_id)
    mount = _mount_of(project) if project is not None else None
    if project is None or mount is None:
        raise PublishRefused("no_project", "this asset is not inside a project")
    rel_path = rel_path_for(mount, Path(asset_ref))
    if rel_path is None:
        raise PublishRefused(
            "outside_project",
            "only assets inside the project folder can be published — a manifest row is a path relative to the project",
        )

    typeid = str(entity.typeid)
    if published:
        info = SchemaRegistry.get(type_name)
        try:
            committed = info.stamp_id(FSRef(asset_ref), str(entity.id))
        except ForeignId as exc:
            raise PublishRefused("foreign_id", f"the file carries an id that is not an entity id: {exc}") from exc
        except NotWritable as exc:
            raise PublishRefused("no_carrier", f"the id cannot be written into this asset: {exc}") from exc
        if committed != str(entity.id):
            raise PublishRefused(
                "carrier_mismatch", f"the file already carries id {committed}, not this row's {entity.id}"
            )
        # The row reflects the stamped carrier before the manifest names it.
        resolved = await resolve_asset(asset_ref, write=False, type_name=type_name, owner_id=str(entity.id))
        await index_one(
            resolved, notify=True, scope=getattr(entity, "scope", None), project_id=str(project.id)
        )
        publish(
            mount,
            make_entry(
                typeid=typeid,
                rel_path=rel_path,
                name=str(getattr(entity, "name", "") or ""),
                description=str(getattr(entity, "description", "") or ""),
                origin=await origin_for_asset(asset_ref),
            ),
        )
        await ensure_manifest_indexed(project)
        reflect_manifest_to_hub_soon(project)
    else:
        await drop_row(project, typeid)

    canonical = await type(entity).get_one({"id": str(entity.id)}) or entity
    if bool(canonical.published) != published:
        # The reconcile is the writer; this only covers the unpublish-with-no-
        # manifest edge (nothing to index) so the caller never sees a lag.
        canonical.published = published
        await canonical.save()
    return canonical


# ── install: a published row → a copy in THIS project ───────────────────────


async def _default_worker() -> str:
    from flow_sdk.core.capabilities.registry import resolve_default_worker_type  # noqa: PLC0415

    try:
        return await resolve_default_worker_type()
    except Exception:  # noqa: BLE001 — no selected harness yet: the .claude layout
        return "claude"


async def _source_root(origin) -> Path:
    """Where the published bytes are on THIS machine — the origin's own path for
    a local origin, a materialized checkout joined with ``rel_path`` otherwise."""
    from flow_sdk.builtin.drivers.local_driver import _resolve_local_path  # noqa: PLC0415
    from flow_sdk.builtin.fs_origin_driver import get_origin_driver  # noqa: PLC0415
    from flow_sdk.fs_store.origin.fs_origin import safe_join  # noqa: PLC0415

    if getattr(origin, "kind", "") == "local":
        return _resolve_local_path(origin)
    local_root, _pid = await get_origin_driver(origin.kind).materialize(origin)
    joined = safe_join(Path(local_root), origin.rel_path or ".")
    if joined is None:
        raise PublishRefused("missing", f"the origin's path {origin.rel_path!r} escapes its checkout")
    return joined


async def resolve_published_row(typeid: str) -> dict:
    """A bare typeid → its published row plus publisher, from the hub's
    ``project/published_asset`` lookup — the ``install_request`` shape, so the
    CLI's ``flow asset install <typeid>`` walks the same path as the dialog."""
    from flow_sdk.cloud_client.transport.hub_http import hub_get  # noqa: PLC0415

    try:
        split_typeid(typeid)
    except ValueError as exc:
        raise PublishRefused("bad_request", str(exc)) from exc
    data = await hub_get("project", None, action="published_asset", params={"typeid": typeid})
    if not isinstance(data, dict) or not data.get("typeid"):
        raise PublishRefused(
            "not_published",
            f"the hub knows no published asset {typeid} you can see — publish it, share its project, "
            "or check this desktop is logged in",
        )
    return data


async def install_published(project, request: dict, *, overwrite: bool = False) -> dict:
    """Copy one published asset (a manifest row, as the hub relays it) into
    ``project`` at its type's placement, index it keeping the publisher's id,
    and record it in ``deps.json``. Returns ``{installed, show, posix_path}``."""
    import shutil  # noqa: PLC0415

    from flow_sdk.assets.project_manifest import make_dependency, record_dependency, rel_path_for  # noqa: PLC0415
    from flow_sdk.core.display_target import entity_target  # noqa: PLC0415
    from flow_sdk.fs_store.placement import resolve_destination  # noqa: PLC0415
    from flow_sdk.fs_store.resolve import index_one, resolve_asset  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
    from flow_sdk.schema.data_spec.project_manifest_spec import PublishedAssetSpec  # noqa: PLC0415

    request = request if isinstance(request, dict) else {}
    try:
        entry = PublishedAssetSpec.model_validate(
            {k: request.get(k) for k in ("typeid", "rel_path", "name", "description", "published_at", "origin") if request.get(k) is not None}
        )
    except Exception as exc:  # noqa: BLE001 — pydantic's message is the reason
        raise PublishRefused("bad_request", f"not a published row: {exc}") from exc
    if entry.origin is None:
        raise PublishRefused("no_origin", "this row carries no origin — nothing says where its files are")
    mount = _mount_of(project)
    if mount is None:
        raise PublishRefused("no_project", "the target project has no folder")

    src = await _source_root(entry.origin)
    if not src.exists():
        raise PublishRefused("missing", f"the published files are not reachable from this machine ({src})")
    if rel_path_for(mount, src) is not None:
        raise PublishRefused("same_project", "that asset already lives in this project")

    family = resolve_destination(entry.type, "project", default_worker=await _default_worker(), project_mount=mount)
    if family is None:
        raise PublishRefused("not_publishable", f"a {entry.type} has no project placement")
    dest = family / src.name
    if dest.exists() and not overwrite:
        raise PublishRefused("exists", f"{dest.name} is already in this project — install with overwrite to replace it")

    def _copy() -> None:
        family.mkdir(parents=True, exist_ok=True)
        if dest.is_symlink() or dest.is_file():
            dest.unlink()   # never rmtree through a link
        elif dest.is_dir():
            shutil.rmtree(dest)
        if src.is_dir():
            shutil.copytree(src, dest, symlinks=False)   # the .flow/capsules sidecar travels with it
        else:
            shutil.copy2(src, dest)

    await asyncio.to_thread(_copy)

    # The copy carries the publisher's id (frontmatter / sidecar); resolving
    # the path adopts it — "Found wins" — so the row keeps that id.
    resolved = await resolve_asset(dest, write=False, type_name=entry.type)
    await index_one(resolved, notify=True, scope="project", project_id=str(project.id))
    cls = SchemaRegistry.get_entity_cls(entry.type)
    ent = await cls.get_one({"id": resolved.id}) if cls is not None else None

    dep = make_dependency(
        entry=entry,
        source_project_id=str(request.get("source_project_id") or ""),
        source_project_name=str(request.get("source_project_name") or ""),
    )
    record_dependency(mount, dep)

    info = SchemaRegistry.get(entry.type)
    show = entity_target(entry.type, resolved.id, name=entry.name or None)
    if ent is not None and info is not None and getattr(info, "setup_skill", None):
        try:
            show = await ent.setup_on_receive(project_id=str(project.id), workdir=str(dest))
        except Exception:  # noqa: BLE001 — setup is best-effort; the install stands
            logger.warning("[project_manifest] setup_on_receive failed for %s", resolved.id, exc_info=True)
    return {"installed": dep.model_dump(mode="json"), "show": show, "posix_path": str(dest), "id": resolved.id}


# ── hub reflection ───────────────────────────────────────────────────────────


async def reflect_manifest_to_hub(project) -> bool:
    """Hand the manifest DOCUMENT to the hub project of the same id, so the
    hub's Discover shows what this project published — the way a shared doc
    is visible there. Best effort: no cloud login, no hub row, or a hub
    failure means "not reflected", never a failed publish. The file on disk
    stays the truth; re-sends converge (the hub replaces the whole document)."""
    from flow_sdk.assets.project_manifest import ManifestError, read_manifest  # noqa: PLC0415
    from flow_sdk.cloud_client.transport.hub_http import hub_post  # noqa: PLC0415

    mount = _mount_of(project)
    if mount is None:
        return False
    try:
        spec = read_manifest(mount)
    except ManifestError:
        return False
    document = spec.to_document() if spec is not None else None
    try:
        result = await hub_post("project", {"manifest": document}, str(project.id), action="publish_manifest")
    except Exception as exc:  # noqa: BLE001 — logged, never raised into the toggle
        logger.info("[project_manifest] hub reflection skipped for %s: %s", project.id, exc)
        return False
    return result is not None


_REFLECTIONS: set[asyncio.Task] = set()


def reflect_manifest_to_hub_soon(project) -> None:
    """Reflect off the toggle's critical path: the person sees the local
    result immediately, the hub catches up a round-trip later."""
    task = asyncio.create_task(reflect_manifest_to_hub(project))
    _REFLECTIONS.add(task)
    task.add_done_callback(_REFLECTIONS.discard)


async def drop_row(project, typeid: str):
    """Remove one row from the project's manifest (the shared half of unpublish
    and of the `missing`-row removal): drop, re-index so caches follow, reflect."""
    from flow_sdk.assets.project_manifest import unpublish  # noqa: PLC0415

    mount = _mount_of(project)
    if mount is None:
        raise PublishRefused("no_project", "the project has no folder")
    spec = unpublish(mount, typeid)
    await ensure_manifest_indexed(project)
    reflect_manifest_to_hub_soon(project)
    return spec


# ── the read view ────────────────────────────────────────────────────────────

_STALE_GRACE_SECONDS = 2.0


def _carrier_mtime(path: Path, info) -> float:
    """The freshness of an asset = the mtime of its main document (the
    registry's own rule, ``body_path_for``)."""
    try:
        return info.body_path_for(path).stat().st_mtime
    except OSError:
        return 0.0


async def rows_by_id(type_name: str, ids: list[str]) -> dict[str, Entity]:
    """One query per type instead of one per row."""
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    info = SchemaRegistry.get(type_name)
    cls = info.entity_cls if info is not None else None
    if cls is None or not ids:
        return {}
    query = QueryFilter(type=type_name, match=ExpressionNode(op=QueryOp.IN, operands=["id", list(ids)]))
    rows = await cls.get_all(query)
    return {str(r.id): r for r in rows or []}


async def published_view(project) -> dict:
    """``GET project/{id}/published`` — the contract in
    ``flow_sdk.assets.project_manifest``'s docstring, joined with local state."""
    from flow_sdk.assets.project_manifest import MANIFEST_REL_PATH, ManifestError, read_manifest  # noqa: PLC0415
    from flow_sdk.builtin.agentic_process.agentic_process import (  # noqa: PLC0415
        AssetSource,
        collect_base_source_dirs,
        scan_path_asset_descriptors,
    )
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
    from flow_sdk.schema.data_spec.project_manifest_spec import PUBLISHABLE_TYPES, split_typeid  # noqa: PLC0415

    mount = _mount_of(project)
    spec = None
    if mount is not None:
        try:
            spec = read_manifest(mount)
        except ManifestError:
            spec = None
    manifest_row = await ProjectManifest.get_one({"project_id": str(project.id)}) if spec is not None else None
    manifest = {
        "exists": spec is not None,
        "schema": spec.manifest_schema if spec is not None else None,
        "requires": dict(spec.requires) if spec is not None else {},
        "rel_path": MANIFEST_REL_PATH,
        "typeid": f"project_manifest-{manifest_row.id}" if manifest_row is not None else None,
    }

    from flow_sdk.builtin.agentic_process.cli_drivers.session_paths import parse_iso_datetime  # noqa: PLC0415

    entries = list(spec.entries) if spec is not None else []
    by_type: dict[str, list[str]] = {}
    for entry in entries:
        by_type.setdefault(entry.type, []).append(entry.id)
    found = {t: await rows_by_id(t, ids) for t, ids in by_type.items()}

    rows: list[dict] = []
    for entry in entries:
        info = SchemaRegistry.get(entry.type)
        ent = found.get(entry.type, {}).get(entry.id)
        on_disk = mount is not None and (mount / entry.rel_path).exists()
        if ent is None:
            state = "install" if on_disk else "missing"
        else:
            stamped = parse_iso_datetime(entry.published_at)
            newer = (
                stamped is not None
                and info is not None
                and _carrier_mtime(mount / entry.rel_path, info) > stamped.timestamp() + _STALE_GRACE_SECONDS
            )
            state = "stale" if newer else "in_use"
        rows.append(
            {
                "typeid": entry.typeid,
                "type": entry.type,
                "id": entry.id,
                "name": entry.name or (ent.name if ent is not None else ""),
                "description": entry.description,
                "rel_path": entry.rel_path,
                "published_at": entry.published_at,
                "state": state,
                "origin": entry.origin.model_dump(mode="json") if entry.origin is not None else None,
                "posix_path": str(mount / entry.rel_path) if on_disk else None,
                "indexed": ent is not None,
            }
        )

    unpublished: list[dict] = []
    if mount is not None:
        from flow_sdk.schema.data_spec.project_manifest_spec import split_typeid  # noqa: PLC0415

        sources, _seen = collect_base_source_dirs(project)
        listed = spec.typeids if spec is not None else frozenset()
        descriptors = [
            d
            for d in await scan_path_asset_descriptors(
                sources, own_project_id=str(project.id), types=list(PUBLISHABLE_TYPES), limit=2000
            )
            if d.source is AssetSource.PROJECT_DIR and d.typeid not in listed
        ]
        wanted: dict[str, list[str]] = {}
        for d in descriptors:
            t, i = split_typeid(d.typeid)
            wanted.setdefault(t, []).append(i)
        names = {t: await rows_by_id(t, ids) for t, ids in wanted.items()}
        for d in descriptors:
            t, i = split_typeid(d.typeid)
            ent = names.get(t, {}).get(i)
            unpublished.append(
                {
                    "typeid": d.typeid,
                    "type": t,
                    "name": d.name or (ent.name if ent is not None else ""),
                    "posix_path": d.posix_path,
                    "project_id": d.project_id,
                }
            )

    return {"manifest": manifest, "rows": rows, "unpublished": unpublished}


# ── HTTP: one base-class action, two project actions ────────────────────────


async def _http_set_published(self: Entity):
    """``POST /graph/<type>/<id>/set-published`` body ``{published, project_id?}``.
    Registered bare-name so every type resolves it; the verb itself refuses
    anything that is not publishable."""
    from flow_sdk.request_context.json_body import read_json_body  # noqa: PLC0415
    from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415
    from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

    body = await read_json_body(get_current_request_info())
    if isinstance(body, ApiFailResponse):
        return body
    published = bool(body.get("published", True))
    project_id = body.get("project_id") or None
    try:
        canonical = await set_published(self, published=published, project_id=project_id)
    except PublishRefused as exc:
        return ApiFailResponse(message=str(exc), status_code=400, data={"code": exc.code})
    return ApiSuccessResponse(data=canonical.model_dump(mode="json"))


_action_registry.register(
    action_name="set-published",
    function_name="set_published",
    handler=_http_set_published,
    methods="post",
    types="all",
)
