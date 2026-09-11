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
    from flow_sdk.builtin.asset_publishing import owning_project  # noqa: PLC0415
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


async def set_published(entity: Entity, *, published: bool, project_id: str | None = None, actor=None) -> Entity:
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
        publish_body_to_hub_soon(entity, project, actor)
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
    from flow_sdk.assets.asset import Asset  # noqa: PLC0415
    from flow_sdk.assets.project_manifest import make_dependency, record_dependency, rel_path_for  # noqa: PLC0415
    from flow_sdk.core.display_target import entity_target  # noqa: PLC0415
    from flow_sdk.fs_store.placement import Scope  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
    from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415
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

    from flow_sdk.builtin.asset_installation import index_installed_asset
    from flow_sdk.fs_store.placement import resolve_default_harness, resolve_destination

    asset = Asset.from_path(src)
    if asset.typeid != TypeId(entry.typeid):
        raise PublishRefused("identity_mismatch", "the published files do not carry the requested asset identity")
    info = SchemaRegistry.get(asset.typeid.type)
    family = resolve_destination(asset.typeid.type, Scope.PROJECT,
                                 default_worker=await resolve_default_harness(), project_mount=mount)
    if family is None:
        raise PublishRefused("unsupported", "this asset cannot be installed in a project")
    destination = family if info.singleton else family / asset.path.name
    try:
        import asyncio
        installed = await asyncio.to_thread(asset.install, destination, overwrite=overwrite)
        await index_installed_asset(asset, installed, scope=Scope.PROJECT, project_id=str(project.id))
    except FileExistsError as exc:
        raise PublishRefused("exists", f"{src.name} is already in this project — install with overwrite to replace it") from exc
    dest = installed.path
    cls = SchemaRegistry.get_entity_cls(entry.type)
    ent = await cls.get_one({"id": installed.typeid.id}) if cls is not None else None

    dep = make_dependency(
        entry=entry,
        source_project_id=str(request.get("source_project_id") or ""),
        source_project_name=str(request.get("source_project_name") or ""),
    )
    record_dependency(mount, dep)

    info = SchemaRegistry.get(entry.type)
    show = entity_target(entry.type, installed.typeid.id, name=entry.name or None)
    if ent is not None and info is not None and getattr(info, "setup_skill", None):
        try:
            show = await ent.setup_on_receive(project_id=str(project.id), workdir=str(dest))
        except Exception:  # noqa: BLE001 — setup is best-effort; the install stands
            logger.warning("[project_manifest] setup_on_receive failed for %s", installed.typeid.id, exc_info=True)
    return {"installed": dep.model_dump(mode="json"), "show": show, "posix_path": str(dest), "id": installed.typeid.id}


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


# ── the document itself, on the hub ──────────────────────────────────────────
#
# The manifest row says WHAT was published and WHERE its bytes are; the hub can
# only render the document when it holds the tree. That is the git share path
# (``publish_git_asset``: commit the asset to the project's ``flow-cloud``
# branch, register it under the hub project) plus the hub's own snapshot
# (``gitops/materialize``). Both are best-effort here: a publish is a manifest
# fact and never waits on GitHub.

_BODY_TASKS: set[asyncio.Task] = set()
#: What the last publish did about the hub body, per typeid — read by the desk's
#: published view so the row can say why the document is (not) on the hub.
_HUB_BODY: dict[str, dict] = {}


def _skipped(code: str) -> dict:
    return {"status": "skipped", "code": code}


def _failed(code: str) -> dict:
    return {"status": "failed", "code": code}


async def publish_body_to_hub(entity: Entity, project, actor) -> dict:
    """Put the asset's document on the hub, and say what happened as
    ``{status: published|skipped|failed, code}`` — the row's ``hub_body``.

    Gates in order — the first that fails is the answer (``skipped``): the
    type must be git-publishable, the project linked to the cloud, and the
    actor connected to GitHub. Then the share path pushes ``flow-cloud`` and
    registers the asset; then the hub snapshots the tree (either refusal is
    ``failed``)."""
    from flow_sdk.assets.git_publish import AssetPublishError
    from flow_sdk.builtin.asset_publishing import publish_git_asset  # noqa: PLC0415
    from flow_sdk.cloud_client.transport.hub_http import hub_post  # noqa: PLC0415
    from flow_sdk.core.oauth.github_credentials import get_github_token  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    info = SchemaRegistry.get(entity.get_type())
    if info is None or not info.git_publishable:
        return _skipped("type_not_git")
    if getattr(project, "remote", False) is not True:
        return _skipped("project_not_linked")
    if actor is None or not await get_github_token(actor):
        return _skipped("github_not_connected")
    try:
        await publish_git_asset(entity, actor)
    except AssetPublishError as exc:
        return _failed(str(getattr(exc.code, "value", exc.code)))
    try:
        await hub_post(entity.get_type(), {}, str(entity.id), action="gitops", sub_path="materialize")
    except Exception as exc:  # noqa: BLE001 — logged below; the row still says what happened
        logger.info("[project_manifest] hub materialize skipped for %s: %s", entity.typeid, exc)
        return _failed("materialize_failed")
    return {"status": "published", "code": None}


def publish_body_to_hub_soon(entity: Entity, project, actor) -> None:
    """Run ``publish_body_to_hub`` in the background and remember its outcome."""
    typeid = str(entity.typeid)

    async def _run() -> None:
        try:
            _HUB_BODY[typeid] = await publish_body_to_hub(entity, project, actor)
        except Exception as exc:  # noqa: BLE001 — never into the toggle
            logger.warning("[project_manifest] hub body publish failed for %s: %s", typeid, exc)
            _HUB_BODY[typeid] = _failed("publish_failed")

    task = asyncio.create_task(_run())
    _BODY_TASKS.add(task)
    task.add_done_callback(_BODY_TASKS.discard)


async def drain_hub_tasks() -> None:
    """Await every background hub task — a test seam, so an assertion can read
    the outcome the toggle deliberately did not wait for."""
    pending = list(_REFLECTIONS | _BODY_TASKS)
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)


async def drop_row(project, typeid: str):
    """Remove one row from the project's manifest (the shared half of unpublish
    and of the `missing`-row removal): drop, re-index so caches follow, reflect."""
    from flow_sdk.assets.project_manifest import unpublish  # noqa: PLC0415

    mount = _mount_of(project)
    if mount is None:
        raise PublishRefused("no_project", "the project has no folder")
    spec = unpublish(mount, typeid)
    _HUB_BODY.pop(typeid, None)
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
    from flow_sdk.assets.catalog import AssetSource, scan_path_asset_descriptors
    from flow_sdk.assets.project_manifest import MANIFEST_REL_PATH, ManifestError, read_manifest  # noqa: PLC0415
    from flow_sdk.builtin.asset_context import collect_base_source_dirs
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
                "hub_body": _HUB_BODY.get(entry.typeid),
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
    request_info = get_current_request_info()
    actor = request_info.someone_typeid if request_info is not None else None
    try:
        canonical = await set_published(self, published=published, project_id=project_id, actor=actor)
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
