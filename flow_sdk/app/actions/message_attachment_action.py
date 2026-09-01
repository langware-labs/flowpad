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
)
from flow_sdk.builtin.user import User
from flow_sdk.fs_store.operations.flow_message import default_data_dir, unpacked_dir
from flow_sdk.fs_store.record_paths import record_stem
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import (
    ApiFailResponse,
    ApiResponse,
    ApiResponseStatus,
    ApiSuccessResponse,
)

logger = logging.getLogger(__name__)

# Read cap for staged-file-content — the review modal renders docs, not blobs.
_STAGED_READ_CAP = 512 * 1024



def _origin_map(entry_key: str, ma) -> dict:
    """The staged attachment's origin as the bundle-shaped ``{key: dump}`` map."""
    return {entry_key: ma.origin.model_dump(mode="python")} if ma.origin else {}


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
    """Root that user-scope installs copy under — delegates to the single
    ``placement.root_for_scope`` authority (shared with the create path), so the
    two can't diverge on what "user root" means. Kept as a named seam because
    tests monkeypatch it to redirect installs to a temp home."""
    from flow_sdk.fs_store.placement import Scope, root_for_scope  # noqa: PLC0415

    return root_for_scope(Scope.USER)


async def _load_ma(attachment_id: str) -> MessageAttachment | None:
    return await MessageAttachment.get_one({"id": attachment_id})


async def _maybe_mint_bookmark(ma: MessageAttachment, someone_typeid) -> None:
    """If the sender opted in (``ma.create_bookmark``), mint a FAVORITE bookmark
    on the receiver pointing at the just-installed entity. Best-effort: a mint
    failure never aborts a successful install. Loads the materialized entity to
    read its local ``asset_ref`` (git artifacts carry ``""`` until opened — the
    favorite navigates by id and the artifact-open path resolves the checkout)."""
    if not ma.create_bookmark:
        return
    from flow_sdk.builtin.bookmark import mint_share_favorite  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    cls = SchemaRegistry.get_entity_cls(ma.asset_type)
    ent = await cls.get_one({"id": ma.asset_id}) if cls is not None else None
    try:
        await mint_share_favorite(
            owner=someone_typeid,
            entity_type=ma.asset_type,
            entity_id=ma.asset_id,
            title=ma.name or (getattr(ent, "display_name", None) if ent else None) or ma.asset_id,
            asset_ref=str(getattr(ent, "asset_ref", "") or ""),
            icon=SchemaRegistry.get_icon(ma.asset_type),
        )
    except Exception:
        logger.warning("[message_attachment] bookmark mint failed for %s", ma.asset_id, exc_info=True)


async def _setup_after_install(
    ma: MessageAttachment,
    installed_root: str | None,
    *,
    auto_run: bool = True,
) -> dict | None:
    """The per-type reception dispatch: what to SHOW post-install.

    A type with no ``setup_skill`` just opens the received entity — its target is
    built from ``(asset_type, asset_id)`` with no entity load (the common markdown/
    file case). Only a type that actually spawns a setup session loads the entity
    and calls ``Entity.setup_on_receive``. ``auto_run=False`` forces that plain
    open even for a setup-capable type — Git Download defers setup to the explicit
    ``setup`` action. Best-effort — a setup failure never fails the install."""
    from flow_sdk.core.display_target import entity_target  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    info = SchemaRegistry.get(ma.asset_type)
    if not auto_run or info is None or not getattr(info, "setup_skill", None):
        return entity_target(ma.asset_type, ma.asset_id, name=ma.name)

    cls = SchemaRegistry.get_entity_cls(ma.asset_type)
    ent = await cls.get_one({"id": ma.asset_id}) if cls is not None else None
    if ent is None:
        return entity_target(ma.asset_type, ma.asset_id, name=ma.name)
    try:
        return await ent.setup_on_receive(project_id=ma.project_id, workdir=installed_root)
    except Exception:
        logger.warning("[message_attachment] setup_on_receive failed for %s", ma.asset_id, exc_info=True)
        return entity_target(ma.asset_type, ma.asset_id, name=ma.name)


async def _cross_link_installed_siblings(ma: MessageAttachment) -> None:
    """Give this just-installed attachment the message's OTHER installed
    attachments in its private context — and itself into theirs.

    Receiver-side only, by design: ``private_context_entities_`` is local-only
    (``share()`` strips it), so a sender-side link would never reach anyone —
    the recipient must build its own.

    It cannot run at message-arrival time either: a bundle's assets stay STAGED
    (never indexed, never visible to agents) until installed, so the sibling
    entities simply do not exist locally yet and would not resolve. They
    materialize one install at a time, so we (re)link the whole installed set on
    each install — idempotent and convergent: installing #2 links #1<->#2,
    installing #3 links all three. Still-staged siblings are skipped; they link
    themselves in when installed.

    Best-effort — never fails the install. That promise covers the imports too:
    they sit inside the guard because ``_finalize_install`` calls this unguarded,
    so an ImportError here would otherwise take down every install.
    """
    if not ma.flow_message_id:
        return
    try:
        from flow_sdk.core.entity.cross_link import cross_link_all  # noqa: PLC0415
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
    except Exception as e:  # noqa: BLE001
        logger.warning("[message_attachment] cross-link unavailable (non-fatal): %s", e, exc_info=True)
        return
    try:
        siblings = await MessageAttachment.get_all({"flow_message_id": ma.flow_message_id})
    except Exception as e:  # noqa: BLE001
        logger.warning(
            "[message_attachment] sibling lookup for %s failed (non-fatal): %s",
            ma.flow_message_id,
            e,
            exc_info=True,
        )
        return

    entities: list = []
    seen: set[str] = set()
    for row in siblings:
        if not row.installed:
            continue  # still staged — no local entity to link yet
        tid = row.target_typeid
        if tid is None or str(tid) in seen:
            continue
        seen.add(str(tid))
        try:
            cls = SchemaRegistry.get_entity_cls(tid.type)
            ent = await cls.get_one({"id": tid.id}) if cls is not None else None
            if ent is not None:
                entities.append(ent)
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "[message_attachment] cross-link load %s failed (non-fatal): %s",
                tid,
                e,
                exc_info=True,
            )

    if len(entities) < 2:
        return
    try:
        await cross_link_all(entities)
    except Exception as e:  # noqa: BLE001
        logger.warning(
            "[message_attachment] attachment cross-link failed (non-fatal): %s",
            e,
            exc_info=True,
        )


async def _apply_receive_row_overrides(ma: MessageAttachment, someone_typeid) -> None:
    """Stamp the type's declared ``TypeInfo.receive_row_overrides`` onto the row
    that was just installed — for EVERY branch, not just the row-only one.

    Branch-independent on purpose. ``_install_row_entity`` can fold the overrides
    into its create payload because it builds the row itself, but the file-backed
    branch materializes its row through ``index_attachments`` (i.e. from disk),
    which knows nothing about reception state. Without this, a declared flag like
    ``received=True`` would apply only to types that happen to be row-only, so
    moving a type off ``receive_policy='auto'`` would silently drop it.

    Idempotent: re-applying the same declared values over the row-only branch's
    payload merge is a no-op.
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    info = SchemaRegistry.get(ma.asset_type)
    overrides = getattr(info, "receive_row_overrides", None) or {}
    if not overrides or not ma.asset_id:
        return
    cls = SchemaRegistry.get_entity_cls(ma.asset_type)
    if cls is None:
        return
    try:
        ent = await cls.get_one({"id": ma.asset_id})
        if ent is None:
            return
        dirty = False
        for key, value in overrides.items():
            if getattr(ent, key, None) != value:
                setattr(ent, key, value)
                dirty = True
        if dirty:
            await ent.save(someone_typeid)
    except Exception:  # never fail an otherwise-successful install on this
        logger.warning("[install] receive_row_overrides failed for %s-%s", ma.asset_type, ma.asset_id, exc_info=True)


async def _finalize_install(
    ma: MessageAttachment,
    scope: str,
    project_id: str | None,
    installed_root: str | None,
    someone_typeid,
) -> ApiResponse:
    """Shared install tail (every branch: file-backed, git-reference, copy-artifact):
    stamp install state, persist+notify, mint the favorite if opted in, then run the
    per-type reception setup and return ``{entity, show}`` — ``show`` is the
    DisplayTarget the FE navigates to (the received entity, or a spawned Vibe
    setup session)."""
    ma.scope = scope
    ma.project_id = project_id
    ma.installed_root = installed_root
    ma.installed_at = datetime.now(UTC)
    await ma.save(someone_typeid, notify=True)
    await _apply_receive_row_overrides(ma, someone_typeid)
    await _maybe_mint_bookmark(ma, someone_typeid)
    # Now that this asset is a real local entity, link it with the message's
    # other installed attachments (each one's private context gains the rest).
    await _cross_link_installed_siblings(ma)
    # Git Download clones + indexes only — setup NEVER runs automatically (it's a
    # separate, explicit action; see ``handle_attachment_setup``). Copy-mode
    # install keeps its existing behavior: setup-capable types spawn setup here.
    show = await _setup_after_install(
        ma,
        installed_root,
        auto_run=ma.transfer_mode != TransferMode.GIT.value,
    )
    return ApiSuccessResponse(data={"entity": ma, "show": show})


async def _install_row_entity(
    ma: MessageAttachment,
    scope: str,
    project_id: str | None,
    *,
    overwrite: bool,
    someone_typeid,
) -> ApiResponse:
    """Install a row-only received entry (``TypeInfo.receive_policy == "auto"``:
    claude_session, flowpad_diagnosis): materialize the entity row from the
    staged ``header.json`` — the same create-or-fill-merge contract the legacy
    per-type unpack branches used (a partial row never blocks the real
    name/slug). No bytes are copied and no reindex runs (row-only types have no
    record folder); ``project_id`` stays null so scope inherits live through
    the parent-chain fallback (``Entity.effective_project_id``)."""
    from flow_sdk.builtin.flow_message_bundle import (  # noqa: PLC0415
        _fill_merge_entity,
        _read_entity_header,
    )
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    entry_dir = _entry_dir_for(ma)
    if entry_dir is None or not entry_dir.exists():
        return _staging_gone()
    header = _read_entity_header(entry_dir)
    if header is None:
        return ApiFailResponse(message="staged entry has no header.json", status_code=410)
    cls = SchemaRegistry.get_entity_cls(ma.asset_type)
    if cls is None:
        return ApiFailResponse(message=f"unknown entity type: {ma.asset_type!r}", status_code=400)
    info = SchemaRegistry.get(ma.asset_type)
    overrides = getattr(info, "receive_row_overrides", None) or {}
    payload = {**header, "id": header.get("id") or ma.asset_id, **overrides}
    existing = await cls.get_one({"id": payload["id"]})
    if existing is None or overwrite:
        await cls.model_validate(payload).save(someone_typeid)
    elif _fill_merge_entity(existing, payload, ("id", "type")):
        await existing.save(someone_typeid)
    return await _finalize_install(
        ma,
        scope,
        project_id if scope == AttachmentScope.PROJECT.value else None,
        None,
        someone_typeid,
    )


async def _install_artifact_reference(
    ma: MessageAttachment,
    scope: str,
    project_id: str | None,
    *,
    overwrite: bool,
    someone_typeid,
) -> ApiResponse:
    """Install a staged git-reference graph entity (artifact or folder):
    materialize its graph row from the staged metadata (path unset — the
    checkout resolves later at open, via the git wizard). No clone here. Then
    mint the favorite if opted in."""
    from flow_sdk.builtin.flow_message_bundle import (  # noqa: PLC0415
        FlowMessageExistsError,
        _notify_received_assets,
        _restore_git_reference_entity_entry,
    )

    if not ma.git_transfer:
        return ApiFailResponse(message="git transfer metadata missing", status_code=410)
    unpacked_root = unpacked_dir(ma.flow_message_id)
    if not unpacked_root.exists():
        return _staging_gone()
    entry_key = record_stem(ma.asset_type, ma.asset_id)
    try:
        ok = await _restore_git_reference_entity_entry(
            unpacked_root,
            entry_key,
            ma.git_transfer,
            _origin_map(entry_key, ma),
            overwrite=overwrite,
            owner_typeid=someone_typeid,
        )
    except FlowMessageExistsError as e:
        return ApiFailResponse(
            message="artifact already exists — overwrite?",
            status_code=409,
            data={"asset_conflict": True, "conflicts": getattr(e, "conflicts", None)},
        )
    if not ok:
        return ApiFailResponse(message="git reference restore failed", status_code=500)
    await _notify_received_assets({(ma.asset_type, ma.asset_id)})
    # A graph artifact has no copied bytes → no installed_root; the checkout
    # resolves at open. Project scope still records project_id.
    return await _finalize_install(
        ma,
        scope,
        project_id if scope == AttachmentScope.PROJECT.value else None,
        None,
        someone_typeid,
    )


async def _install_webapp_artifact_copy(
    ma: MessageAttachment,
    scope: str,
    project_id: str | None,
    *,
    overwrite: bool,
    someone_typeid,
) -> ApiResponse:
    """Install a copy-mode folder webapp ARTIFACT: mirror its staged folder bytes
    into the target project and materialize the row pointing ``path`` at the served
    folder (no clone). A webapp always installs into a project (its served root
    can't live under ``~/.claude``)."""
    from flow_sdk.builtin.flow_message_bundle import (  # noqa: PLC0415
        FlowMessageExistsError,
        _notify_received_assets,
        _restore_webapp_artifact_entry,
    )

    if scope != AttachmentScope.PROJECT.value or not project_id:
        return ApiFailResponse(message="a webapp artifact installs into a project", status_code=400)
    from flow_sdk.builtin.project import Project  # noqa: PLC0415

    project = await Project.get_one({"id": project_id})
    mount = (getattr(project, "fs_storage_mount_path", "") or "").strip() if project else ""
    if not mount:
        return ApiFailResponse(message=f"Project not found or unmounted: {project_id}", status_code=404)
    root = Path(mount)

    entry_dir = _entry_dir_for(ma)
    if entry_dir is None or not entry_dir.exists():
        return _staging_gone()
    try:
        served = await _restore_webapp_artifact_entry(
            entry_dir,
            root,
            ma.git_transfer or {},
            unpacked_dir(ma.flow_message_id),
            asset_id=ma.asset_id,
            project_id=project_id,
            overwrite=overwrite,
            owner_typeid=someone_typeid,
        )
    except FlowMessageExistsError as e:
        return ApiFailResponse(
            message="artifact already exists — overwrite?",
            status_code=409,
            data={"asset_conflict": True, "conflicts": getattr(e, "conflicts", None)},
        )
    if served is None:
        return ApiFailResponse(message="webapp artifact restore failed", status_code=500)
    await _notify_received_assets({(ma.asset_type, ma.asset_id)})
    return await _finalize_install(ma, scope, project_id, str(root), someone_typeid)


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
        ReceivedAsset,
        _restore_file_backed_entry,
        _restore_git_transfer_entry,
        index_attachments,
    )
    from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415
    from flow_sdk.schema.types import EntityType  # noqa: PLC0415

    ma = await _load_ma(attachment_id)
    if ma is None:
        return _not_found(attachment_id)
    if scope not in (AttachmentScope.USER.value, AttachmentScope.PROJECT.value):
        return ApiFailResponse(message=f"invalid scope: {scope!r}", status_code=400)

    # Row-only auto types (receive_policy='auto'): materialize the entity row
    # from the staged header — no bytes, no reindex.
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    if getattr(SchemaRegistry.get(ma.asset_type), "receive_policy", None) == "auto":
        return await _install_row_entity(
            ma,
            scope,
            project_id,
            overwrite=overwrite,
            someone_typeid=someone_typeid,
        )

    # Git-reference graph entities (ARTIFACT, and FOLDER for git context-folder
    # chips): materialized from the staged metadata here. No bytes copied, no
    # clone (that happens at open / via the chip's wizard).
    if (
        ma.asset_type in (EntityType.ARTIFACT.value, EntityType.FOLDER.value)
        and ma.transfer_mode == TransferMode.GIT.value
    ):
        return await _install_artifact_reference(
            ma,
            scope,
            project_id,
            overwrite=overwrite,
            someone_typeid=someone_typeid,
        )
    # Copy mode: a webapp ARTIFACT can't be a git reference — mirror the shipped
    # folder bytes and serve them.
    if ma.asset_type == EntityType.ARTIFACT.value:
        return await _install_webapp_artifact_copy(
            ma,
            scope,
            project_id,
            overwrite=overwrite,
            someone_typeid=someone_typeid,
        )

    # Untyped FILE attachments have no TypeInfo/RecordType and no schema-derived
    # main_subdir — their staged entry dir already carries the canonical install
    # relpath (``docs/<name>`` for markdown, ``<name>`` at the project root
    # otherwise; see ``placement.untyped_rel_subdir``). Only markdown gets a
    # follow-up index walk — there is still no walker for untyped blobs.
    is_raw_file = ma.asset_type == "file"

    # Resolve the asset class (placement axis) once. An untyped file has no
    # TypeInfo, so its class comes from the filename via the same fallback the
    # staged relpath was built from — which is what lets the ONE user-scope
    # policy below (``user_scope_allowed``) govern it like every other class.
    from flow_sdk.fs_store.placement import untyped_fallback_class, user_scope_allowed  # noqa: PLC0415

    if is_raw_file:
        asset_class = untyped_fallback_class(ma.name or "")
    else:
        info = SchemaRegistry.get(ma.asset_type)
        asset_class = info._resolved_layout[0] if info else None
        if asset_class is None:
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
            # Same policy that stamped `user_scope_allowed` at stage time —
            # the single owner is placement.user_scope_allowed.
            if not user_scope_allowed(asset_class):
                return ApiFailResponse(
                    message=f"type {ma.asset_type!r} is project-scoped; install into a project instead",
                    status_code=400,
                )
            root = _user_scope_root()

    entry_key = record_stem(ma.asset_type, ma.asset_id)
    if is_raw_file:
        # Markdown → indexed as MARKDOWN wherever it lands; other blobs copy
        # without a follow-up walk (there is still no walker for untyped bytes).
        # record_type=None means "copy, don't reindex".
        from flow_sdk.builtin.flow_message_bundle import is_markdown_filename  # noqa: PLC0415

        record_type = RecordType.MARKDOWN if is_markdown_filename(ma.name or "") else None
    else:
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
                _origin_map(entry_key, ma),
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
            # The single reception indexer: copy-scope walk (skipped when
            # record_type is None — a raw non-markdown file), git-origin nested
            # re-walk + provenance stamp, and the received-asset notify.
            await index_attachments(
                [
                    ReceivedAsset(
                        root=root,
                        scope=scope,
                        asset_type=ma.asset_type,
                        asset_id=ma.asset_id,
                        entry_key=entry_key,
                        record_type=record_type,
                        origin=ma.origin.model_dump(mode="python") if ma.origin else None,
                    )
                ],
                project_id=project_id,
                owner=someone_typeid,
            )
    except FlowMessageExistsError as e:
        return ApiFailResponse(
            message="asset already exists — overwrite?",
            status_code=409,
            data={"asset_conflict": True, "conflicts": getattr(e, "conflicts", None)},
        )

    # Metadata axis: overlay the portable entity-JSON envelopes (entities.json)
    # onto the freshly materialized rows — parent_type_id / labels / status /
    # semantic_lock, etc. Independent of transfer mode; sender-local fields never
    # travel, so the receiver's own scope/project_id/asset_ref stay intact.
    try:
        from flow_sdk.builtin.flow_message_bundle import apply_entities_overlay  # noqa: PLC0415

        await apply_entities_overlay(unpacked_dir(ma.flow_message_id), someone_typeid)
    except Exception:
        logger.warning("[install] entities.json overlay failed for %s", ma.id, exc_info=True)

    return await _finalize_install(
        ma,
        scope,
        project_id,
        str(root) if root is not None else None,
        someone_typeid,
    )


# ---------------------------------------------------------------------------
# setup — explicit, optional, git only
# ---------------------------------------------------------------------------


async def handle_attachment_setup(attachment_id: str) -> ApiResponse:
    """Run a received asset's optional setup — ONLY when the receiver clicks it.

    Git Download clones + indexes but never auto-runs setup (see
    ``_finalize_install``); this is the separate action the reception UI wires to
    the ``TypeInfo.reception_verb`` button for setup-capable types. Returns the
    ``show`` DisplayTarget (a spawned setup session, or the entity when the type
    has no setup skill) so the FE routes it through ``openDisplayTarget``."""
    ma = await _load_ma(attachment_id)
    if ma is None:
        return _not_found(attachment_id)
    if not ma.scope:
        return ApiFailResponse(message="download the asset before running setup", status_code=409)
    show = await _setup_after_install(ma, ma.installed_root)
    return ApiSuccessResponse(data={"entity": ma, "show": show})


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
    from flow_sdk.fs_store.origin.git_origin import is_safe_rel_path  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    ma = await _load_ma(attachment_id)
    if ma is None:
        return _not_found(attachment_id)
    if not ma.scope:
        return ApiFailResponse(message="attachment is not installed", status_code=409)

    # Row-only auto types installed no bytes — only the entity row goes
    # (the shared destroy tail below); there is no installed_root to sweep.
    row_only = getattr(SchemaRegistry.get(ma.asset_type), "receive_policy", None) == "auto"

    if ma.transfer_mode != TransferMode.GIT.value and not row_only:
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
        for d in sorted(removed_dirs, key=lambda p: len(p.parts), reverse=True):
            cur = d
            while cur != root and root_resolved in cur.resolve().parents:
                try:
                    # Only bundle-tracked files were unlinked above. Pruning
                    # empty parents is safe; an untracked `.flow` metadata
                    # tree deliberately keeps the asset folder alive.
                    cur.rmdir()
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
    return ApiSuccessResponse(
        data={
            "files": files,
            "main_file": main_rel,
            "root": ma.unpacked_path,
            # Absolute staged dir — "Test it" references the skill by path when it
            # isn't installed yet (a local-disk path handed to a local process).
            "abs_root": str(entry_dir),
        }
    )


async def handle_staged_file_content(attachment_id: str, rel_path: str) -> ApiResponse:
    from flow_sdk.fs_store.origin.git_origin import is_safe_rel_path  # noqa: PLC0415

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


async def handle_conversation_install_all(
    conversation_id: str,
    project_id: str | None,
    *,
    someone_typeid=None,
) -> ApiResponse:
    """Install EVERY attachment of a conversation into ``project_id``.

    Backs the "install in project" fan-out: picking a project for one attachment
    binds the whole conversation, so all of its attachments become project assets
    in one shot (and future arrivals auto-install via the reception path). Reuses
    ``handle_attachment_install`` per row — idempotent, and one row's failure never
    aborts the rest. Pure git-transfer references are skipped: their placement is
    repo-determined, not scope-driven. Rows already filed under this project are
    skipped.
    """
    if not conversation_id:
        return ApiFailResponse(message="conversation_id is required", status_code=400)
    if not project_id:
        return ApiFailResponse(message="project_id is required", status_code=400)
    try:
        attachments = await MessageAttachment.get_all({"conversation_id": conversation_id})
    except Exception as e:  # noqa: BLE001
        logger.error(
            "[message_attachment] conversation %s attachment lookup failed: %s",
            conversation_id,
            e,
            exc_info=True,
        )
        return ApiFailResponse(message=f"attachment lookup failed: {e}")

    installed: list[str] = []
    skipped: list[str] = []
    failed: list[str] = []
    for ma in attachments:
        if ma.id is None:
            continue
        # Repo-determined placement — never scope-forced into a project.
        if ma.transfer_mode == TransferMode.GIT.value:
            skipped.append(ma.id)
            continue
        # Already filed under this project — nothing to do.
        if ma.scope == AttachmentScope.PROJECT.value and ma.project_id == project_id:
            skipped.append(ma.id)
            continue
        try:
            res = await handle_attachment_install(
                ma.id,
                AttachmentScope.PROJECT.value,
                project_id,
                someone_typeid=someone_typeid,
            )
            # ``use_enum_values=True`` on ApiResponse stores the enum *value*
            # (the plain string), so compare against ``.value``.
            if getattr(res, "status", None) == ApiResponseStatus.SUCCESS.value:
                installed.append(ma.id)
            else:
                failed.append(ma.id)
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "[message_attachment] conversation fan-out install for %s failed (non-fatal): %s",
                ma.id,
                e,
                exc_info=True,
            )
            failed.append(ma.id)

    return ApiSuccessResponse(data={"installed": installed, "skipped": skipped, "failed": failed})


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


@action.post(action_name="setup", types=["message_attachment"])
async def setup_attachment_action() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No request info found", status_code=400)
        return await handle_attachment_setup(str(request_info.target_entity_typeid.id))
    except Exception as e:
        logger.error("[message_attachment] setup error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"setup failed: {e}")


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


@action.post(action_name="install-attachments", types=["conversation"])
async def install_conversation_attachments_action() -> ApiResponse:
    """Fan out an "install in project" pick to the whole conversation: install
    every attachment of the target conversation into ``project_id``."""
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No request info found", status_code=400)
        body = await request_info.get_post_data() or {}
        project_id = body.get("project_id") or None
        return await handle_conversation_install_all(
            str(request_info.target_entity_typeid.id),
            project_id,
            someone_typeid=await _local_owner_typeid(),
        )
    except Exception as e:
        logger.error("[message_attachment] install-attachments error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"install-attachments failed: {e}")


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
            str(request_info.target_entity_typeid.id),
            rel_path,
        )
    except Exception as e:
        logger.error("[message_attachment] staged-file-content error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"staged-file-content failed: {e}")
