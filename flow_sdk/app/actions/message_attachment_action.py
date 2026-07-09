"""HTTP actions for MessageAttachment — review, install, uninstall staged assets.

  POST /api/v1/graph/message_attachment/{id}/install
  POST /api/v1/graph/message_attachment/{id}/uninstall
  GET  /api/v1/graph/message_attachment/{id}/staged-files
  GET  /api/v1/graph/message_attachment/{id}/staged-file-content?path=<rel>

A received bundle's file-backed assets stay STAGED under the owning
FlowMessage's record-data dir (never indexed, never visible to agents) until
the user installs them here — the ONLY place reception copies bytes into a
work area and runs an index walk. Uninstall removes the installed copy and the
entity; the staged copy persists so the attachment reverts to reviewable.
"""
from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path

from flow_sdk._compat import UTC
from flow_sdk.actions.action_registry import action
from flow_sdk.builtin.message_attachment import (
    AttachmentScope,
    MessageAttachment,
    TransferMode,
    user_scope_allowed_for,
)
from flow_sdk.builtin.user import User
from flow_sdk.fs_store.operations.flow_message import default_data_dir, unpacked_dir
from flow_sdk.fs_store.record_paths import record_stem
from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)

# Read cap for staged-file-content — the review modal renders docs, not blobs.
_STAGED_READ_CAP = 512 * 1024


async def _local_owner_typeid():
    local_user = await User.get_local()
    return local_user.typeid if local_user else None


def _entry_dir_for(ma: MessageAttachment) -> Path | None:
    """The attachment's staged directory, validated to sit INSIDE the owning
    message's data dir (unpacked_path is stored data — treat as untrusted)."""
    if not ma.flow_message_id or not ma.unpacked_path:
        return None
    base = default_data_dir(ma.flow_message_id).resolve()
    candidate = (base / ma.unpacked_path).resolve()
    try:
        candidate.relative_to(base)
    except ValueError:
        logger.warning("[message_attachment] unpacked_path escapes data dir: %s", ma.unpacked_path)
        return None
    return candidate


def _user_scope_root() -> Path:
    """Root that user-scope installs copy under.

    Bundle relpaths for FS-rooted types are ``.claude/<family>/<leaf>``, so the
    root is the directory whose ``.claude`` is the instance's claude_home
    (= ``Path.home()`` in prod; redirected under FLOWPAD_CLAUDE_HOME in tests,
    which point it at ``<tmp>/.claude`` so the parent stays coherent).
    """
    claude_home = get_instance_settings().claude_home
    if claude_home.name != ".claude":
        logger.warning(
            "[message_attachment] claude_home %s is not named .claude — "
            "user-scope install root may not match discovery", claude_home,
        )
    return claude_home.parent


def _main_subdir_for(asset_type: str) -> str | None:
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
    info = SchemaRegistry.get(asset_type)
    return getattr(info, "main_subdir", None) if info else None


async def _load_ma(attachment_id: str) -> MessageAttachment | None:
    return await MessageAttachment.get_one({"id": attachment_id})


def _not_found(attachment_id: str) -> ApiFailResponse:
    return ApiFailResponse(message=f"MessageAttachment not found: {attachment_id}", status_code=404)


def _staging_gone(suffix: str = "") -> ApiFailResponse:
    return ApiFailResponse(
        message=f"staging area is gone — re-download the message attachments{suffix}",
        status_code=410,
    )


# ---------------------------------------------------------------------------
# install
# ---------------------------------------------------------------------------


async def handle_attachment_install(
    attachment_id: str,
    scope: str,
    project_id: str | None,
    *,
    overwrite: bool = False,
    someone_typeid=None,
) -> ApiResponse:
    """Copy a staged attachment into the chosen scope root and index it there.

    Reuses the bundle restore primitives verbatim: ``_restore_file_backed_entry``
    (idempotent on byte-identical; 409 asset_conflict on a genuine collision —
    retry with overwrite=true) + the scoped reindex + git-origin stamping.
    """
    from flow_sdk.builtin.flow_message_bundle import (  # noqa: PLC0415
        FlowMessageExistsError,
        _notify_received_assets,
        _reindex_git_origin_scopes,
        _reindex_received_assets,
        _reindex_root,
        _restore_file_backed_entry,
        _restore_git_transfer_entry,
        _stamp_git_origins,
    )
    from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415

    ma = await _load_ma(attachment_id)
    if ma is None:
        return _not_found(attachment_id)
    if scope not in (AttachmentScope.USER.value, AttachmentScope.PROJECT.value):
        return ApiFailResponse(message=f"invalid scope: {scope!r}", status_code=400)

    main_subdir = _main_subdir_for(ma.asset_type)
    if main_subdir is None:
        return ApiFailResponse(
            message=f"type {ma.asset_type!r} is not an installable file-backed asset", status_code=400
        )

    # Resolve the target root. For git-mode installs the root is only a clone
    # PREFERENCE (the checkout may live elsewhere), so the user-scope layout
    # gate below applies to copy-mode only.
    root: Path | None = None
    if scope == AttachmentScope.PROJECT.value:
        if not project_id:
            return ApiFailResponse(message="project_id is required for scope=project", status_code=400)
        from flow_sdk.builtin.project import Project  # noqa: PLC0415
        project = await Project.get_one({"id": project_id})
        mount = (getattr(project, "fs_storage_mount_path", "") or "").strip() if project else ""
        if not mount:
            return ApiFailResponse(message=f"Project not found or unmounted: {project_id}", status_code=404)
        root = Path(mount)
    else:
        project_id = None
        if ma.transfer_mode != TransferMode.GIT.value:
            # Same predicate that stamped `user_scope_allowed` at stage time.
            if not user_scope_allowed_for(main_subdir, ma.transfer_mode):
                return ApiFailResponse(
                    message=f"type {ma.asset_type!r} is project-scoped; install into a project instead",
                    status_code=400,
                )
            root = _user_scope_root()

    entry_key = record_stem(ma.asset_type, ma.asset_id)
    try:
        record_type = RecordType(ma.asset_type)
    except ValueError:
        return ApiFailResponse(message=f"unknown record type: {ma.asset_type!r}", status_code=400)

    try:
        if ma.transfer_mode == TransferMode.GIT.value:
            # Clone/pull + index happen HERE, behind explicit consent (at
            # download time the transfer was only recorded on the MA row).
            if not ma.git_transfer:
                return ApiFailResponse(message="git transfer metadata missing", status_code=410)
            unpacked_root = unpacked_dir(ma.flow_message_id)
            if not unpacked_root.exists():
                return _staging_gone()
            restored = await _restore_git_transfer_entry(
                unpacked_root,
                entry_key,
                ma.git_transfer,
                {entry_key: ma.git_origin} if ma.git_origin else {},
                preferred_project_root=root,
                preferred_project_id=project_id,
                overwrite=overwrite,
                owner_typeid=someone_typeid,
            )
            if not restored:
                return ApiFailResponse(message="git transfer restore failed", status_code=500)
        else:
            entry_dir = _entry_dir_for(ma)
            if entry_dir is None or not entry_dir.exists():
                return _staging_gone()
            assert root is not None  # copy mode always resolves a root above
            _restore_file_backed_entry(entry_dir, root, overwrite)
            if scope == AttachmentScope.PROJECT.value:
                await _reindex_received_assets(root, (record_type,), project_id=project_id)
            else:
                await _reindex_root(root, RecordType.USER_HOME_FOLDER, types=(record_type,))
            if ma.git_origin:
                origins = {entry_key: ma.git_origin}
                entries = {(ma.asset_type, ma.asset_id)}
                if scope == AttachmentScope.PROJECT.value:
                    await _reindex_git_origin_scopes(root, entries, origins, project_id=project_id)
                await _stamp_git_origins(entries, origins, someone_typeid)
            await _notify_received_assets({(ma.asset_type, ma.asset_id)})
    except FlowMessageExistsError as e:
        return ApiFailResponse(
            message="asset already exists — overwrite?",
            status_code=409,
            data={"asset_conflict": True, "conflicts": getattr(e, "conflicts", None)},
        )

    ma.scope = scope
    ma.project_id = project_id
    ma.installed_root = str(root) if root is not None else None
    ma.installed_at = datetime.now(UTC)
    await ma.save(someone_typeid, notify=True)
    return ApiSuccessResponse(data=ma)


# ---------------------------------------------------------------------------
# uninstall
# ---------------------------------------------------------------------------


async def handle_attachment_uninstall(attachment_id: str, *, someone_typeid=None) -> ApiResponse:
    """Remove the installed copy; the staged copy persists (revert to staged).

    Copy mode: the staged tree is the manifest — every staged relpath is
    unlinked under ``installed_root`` and empty parents are pruned; the asset
    entity is destroyed (row + record folder + a DELETE data_op).
    Git mode: only the entity row/record goes — the clone may be a shared
    checkout and is never deleted here.
    """
    from flow_sdk.api.api_types.messages import DataOpMessage, OperationType  # noqa: PLC0415
    from flow_sdk.builtin.git_origin import is_safe_rel_path  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    ma = await _load_ma(attachment_id)
    if ma is None:
        return _not_found(attachment_id)
    if not ma.scope:
        return ApiFailResponse(message="attachment is not installed", status_code=409)

    if ma.transfer_mode != TransferMode.GIT.value:
        if not ma.installed_root:
            return ApiFailResponse(message="installed_root missing — cannot uninstall", status_code=409)
        entry_dir = _entry_dir_for(ma)
        if entry_dir is None or not entry_dir.exists():
            return _staging_gone(" to uninstall")
        root = Path(ma.installed_root)
        root_resolved = root.resolve()
        removed_dirs: set[Path] = set()
        for src in entry_dir.rglob("*"):
            if not src.is_file():
                continue
            rel = src.relative_to(entry_dir)
            if not is_safe_rel_path(rel.as_posix()):
                continue
            dest = root / rel
            try:
                dest.resolve().relative_to(root_resolved)
            except ValueError:
                continue
            if dest.exists():
                dest.unlink()
                removed_dirs.add(dest.parent)
        # Prune now-empty dirs up to (not including) the install root.
        import shutil  # noqa: PLC0415
        for d in sorted(removed_dirs, key=lambda p: len(p.parts), reverse=True):
            cur = d
            while cur != root and root_resolved in cur.resolve().parents:
                # The indexer stamps a `.flow/id` capsule into a folder-asset dir;
                # it isn't a bundle-tracked file, so a lone `.flow/` would block
                # the prune. Drop it here (the entity is being destroyed anyway).
                flow_dir = cur / ".flow"
                try:
                    if list(cur.iterdir()) == [flow_dir] and flow_dir.is_dir():
                        shutil.rmtree(flow_dir, ignore_errors=True)
                except OSError:
                    pass
                try:
                    cur.rmdir()  # only succeeds when empty
                except OSError:
                    break
                cur = cur.parent

    # Drop the asset entity (row + record folder) and tell the live UI.
    cls = SchemaRegistry.get_entity_cls(ma.asset_type)
    ent = await cls.get_one({"id": ma.asset_id}) if cls is not None else None
    if ent is not None:
        try:
            op = DataOpMessage(data=ent, op=OperationType.DELETE, to_entity=ent.typeid)
            await ent.add_entity_op_notification(op, notify_immediately=True)
        except Exception:
            logger.warning("[message_attachment] DELETE notify failed for %s", ma.asset_id, exc_info=True)
        await ent.destroy()

    # Clear with '' (not None): entity save serializes exclude-none and the DB
    # merge never removes fields, so a None here would silently keep the old
    # value on the next read (the bookmark-folders lesson). Falsy scope ==
    # staged everywhere (backend + frontend normalize '' → null).
    ma.scope = ""
    ma.project_id = ""
    ma.installed_root = ""
    await ma.save(someone_typeid, notify=True)
    return ApiSuccessResponse(data=ma)


# ---------------------------------------------------------------------------
# staged read surface (review modal)
# ---------------------------------------------------------------------------


async def handle_staged_files(attachment_id: str) -> ApiResponse:
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    ma = await _load_ma(attachment_id)
    if ma is None:
        return _not_found(attachment_id)
    entry_dir = _entry_dir_for(ma)
    if entry_dir is None or not entry_dir.exists():
        return _staging_gone()
    info = SchemaRegistry.get(ma.asset_type)
    main_file = getattr(info, "main_file", None) if info else None
    files = []
    main_rel: str | None = None
    for p in sorted(entry_dir.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(entry_dir).as_posix()
        is_main = bool(main_file) and p.name == main_file
        if is_main and main_rel is None:
            main_rel = rel
        files.append({"path": rel, "size": p.stat().st_size, "is_main": is_main})
    if main_rel is None:
        main_rel = next((f["path"] for f in files if f["path"].endswith(".md")), None)
    return ApiSuccessResponse(data={
        "files": files,
        "main_file": main_rel,
        "root": ma.unpacked_path,
        # Absolute staged dir — "Test it" references the skill by path when it
        # isn't installed yet (a local-disk path handed to a local process).
        "abs_root": str(entry_dir),
    })


async def handle_staged_file_content(attachment_id: str, rel_path: str) -> ApiResponse:
    from flow_sdk.builtin.git_origin import is_safe_rel_path  # noqa: PLC0415

    ma = await _load_ma(attachment_id)
    if ma is None:
        return _not_found(attachment_id)
    if not rel_path or not is_safe_rel_path(rel_path):
        return ApiFailResponse(message="invalid path", status_code=400)
    entry_dir = _entry_dir_for(ma)
    if entry_dir is None or not entry_dir.exists():
        return _staging_gone()
    target = (entry_dir / rel_path).resolve()
    try:
        target.relative_to(entry_dir.resolve())
    except ValueError:
        return ApiFailResponse(message="invalid path", status_code=400)
    if not target.is_file():
        return ApiFailResponse(message=f"no such staged file: {rel_path}", status_code=404)
    with target.open("rb") as fh:
        raw = fh.read(_STAGED_READ_CAP + 1)  # cap+1: never slurp a large staged blob
    if b"\x00" in raw[:8192]:
        return ApiFailResponse(message="binary file — not renderable", status_code=415)
    truncated = len(raw) > _STAGED_READ_CAP
    content = raw[:_STAGED_READ_CAP].decode("utf-8", errors="replace")
    return ApiSuccessResponse(data={"path": rel_path, "content": content, "truncated": truncated})


# ---------------------------------------------------------------------------
# route wrappers
# ---------------------------------------------------------------------------


@action.post(action_name="install", types=["message_attachment"])
async def install_attachment_action() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No request info found", status_code=400)
        body = await request_info.get_post_data() or {}
        scope = str(body.get("scope") or "")
        project_id = body.get("project_id") or None
        overwrite = bool(body.get("overwrite", False))
        return await handle_attachment_install(
            str(request_info.target_entity_typeid.id),
            scope,
            project_id,
            overwrite=overwrite,
            someone_typeid=await _local_owner_typeid(),
        )
    except Exception as e:
        logger.error("[message_attachment] install error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"install failed: {e}")


@action.post(action_name="uninstall", types=["message_attachment"])
async def uninstall_attachment_action() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No request info found", status_code=400)
        return await handle_attachment_uninstall(
            str(request_info.target_entity_typeid.id),
            someone_typeid=await _local_owner_typeid(),
        )
    except Exception as e:
        logger.error("[message_attachment] uninstall error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"uninstall failed: {e}")


@action.get(action_name="staged-files", types=["message_attachment"])
async def staged_files_action() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No request info found", status_code=400)
        return await handle_staged_files(str(request_info.target_entity_typeid.id))
    except Exception as e:
        logger.error("[message_attachment] staged-files error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"staged-files failed: {e}")


@action.get(action_name="staged-file-content", types=["message_attachment"])
async def staged_file_content_action() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No request info found", status_code=400)
        rel_path = str(request_info.request.query_params.get("path") or "")
        return await handle_staged_file_content(
            str(request_info.target_entity_typeid.id), rel_path,
        )
    except Exception as e:
        logger.error("[message_attachment] staged-file-content error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"staged-file-content failed: {e}")
