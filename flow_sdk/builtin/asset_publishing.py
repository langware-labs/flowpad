"""Publish one file-backed asset into its project's hub-hosted repository.

The project's repository on the hub mirrors the project folder: an asset is
pushed there at its project-relative path (``assets/hub_repo_sync.py``), then
registered with ``project/publish_asset``. The hub reads the asset's fields
from the pushed tree itself, and every later push re-syncs it.

Nothing here needs GitHub or makes the project folder a git repository: the
only remote is the hub, reached with the user's hub token.
"""

from __future__ import annotations

from pathlib import Path, PurePosixPath

from flow_sdk.assets.git_publish import (
    AssetPublishCode,
    AssetPublishError,
    AssetPublishResult,
    GitAuthor,
)
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.fs_store.type_id import TypeId


async def owning_project(entity):
    """The Project that owns a file-backed asset, or None.

    Public because the share orchestrator needs the same answer before it
    publishes — two definitions of "which project is this asset in" would let
    the CLI publish under a different project than the one it gated on.
    """
    from flow_sdk.builtin.project import Project  # noqa: PLC0415

    project_id = getattr(entity, "project_id", None) or await entity.effective_project_id()
    if not project_id:
        ancestor = await entity.nearest_ancestor(lambda item: isinstance(item, Project))
        project_id = ancestor.id if ancestor is not None else None
    return await Project.get_one({"id": project_id}) if project_id else None


async def _actor_author(actor: TypeId) -> GitAuthor:
    from flow_sdk.builtin.user import User  # noqa: PLC0415

    user = await User.get_by_typeid(actor)
    name = ((getattr(user, "name", None) or getattr(user, "email", None)) if user else None) or "FlowPad User"
    email = (getattr(user, "email", None) if user else None) or "flowpad@local.invalid"
    return GitAuthor(name=name, email=email, typeid=str(actor))


def publish_asset_payload(project_id: str, asset_type: str, asset_id: str, rel_path: str) -> dict:
    """What ``project/publish_asset`` receives: coordinates only.

    The asset's bytes already sit in the project's hub repo at ``rel_path``; the
    hub reads its fields from that tree, so nothing about the asset's content or
    this machine's paths is sent.
    """
    return {"project": {"id": project_id}, "asset": {"type": asset_type, "id": asset_id}, "rel_path": rel_path}


async def publish_git_asset(entity, actor: TypeId) -> AssetPublishResult:
    """Push ``entity`` into its project's hub repo and register it there.

    If the hub changed the asset since this machine last published it and the
    local copy did not change, the hub's version is pulled into the project
    folder instead (``git.pulled_back``). If both changed, ``ASSET_CONFLICT``.
    """
    from flow_sdk.assets.hub_repo_sync import (  # noqa: PLC0415
        HubRepoMirror,
        last_synced_tree,
        mirror_root,
        remember_sync,
        sync_asset_with_hub,
    )
    from flow_sdk.assets.project_manifest import rel_path_for  # noqa: PLC0415
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.cli.auth.hub_login import resolve_hub_api_key  # noqa: PLC0415
    from flow_sdk.cloud_client.transport.hub_http import HubError, hub_post  # noqa: PLC0415
    from flow_sdk.core.entity.entity_model import _SUPPRESS_STORE  # noqa: PLC0415
    from flow_sdk.fs_store.origin.hub_repo_origin import HubRepoOrigin  # noqa: PLC0415

    info = SchemaRegistry.get(entity.get_type())
    if info is None or not info.git_publishable or not getattr(entity, "asset_ref", None):
        raise AssetPublishError(AssetPublishCode.NOT_GIT_BACKED, "Entity is not a publishable asset")

    project = await owning_project(entity)
    if not isinstance(project, Project):
        raise AssetPublishError(AssetPublishCode.NOT_GIT_BACKED, "Asset has no owning Project")
    if getattr(project, "remote", False) is not True:
        raise AssetPublishError(
            AssetPublishCode.PROJECT_NOT_PUBLISHED,
            "Publish the owning Project before publishing its assets",
        )
    mount_value = getattr(project, "fs_storage_mount_path", None)
    if not mount_value:
        raise AssetPublishError(AssetPublishCode.NOT_GIT_BACKED, "Owning Project has no local mount")

    asset_root = info.storage_root_for(Path(entity.asset_ref))
    try:
        real_asset = asset_root.resolve(strict=True)
        real_mount = Path(mount_value).resolve(strict=True)
    except OSError as exc:
        raise AssetPublishError(AssetPublishCode.NOT_GIT_BACKED, "Asset or Project mount is unavailable") from exc
    if not real_asset.is_relative_to(real_mount):
        raise AssetPublishError(AssetPublishCode.NOT_GIT_BACKED, "Asset is outside its owning Project")
    rel_path = rel_path_for(real_mount, real_asset)
    if rel_path is None or ".git" in PurePosixPath(rel_path).parts:
        raise AssetPublishError(AssetPublishCode.NOT_GIT_BACKED, "Asset path is not publishable")

    token = resolve_hub_api_key(require_live=True)
    if not token:
        raise AssetPublishError(AssetPublishCode.HUB_PUBLISH_FAILED, "Cloud login required")

    try:
        repo = await hub_post("project", {}, project.id, action="hosted_repo")
    except HubError as exc:
        raise AssetPublishError(
            AssetPublishCode.HUB_PUBLISH_FAILED, "The hub has no repository for this project"
        ) from exc
    if not repo or not repo.get("clone_url"):
        raise AssetPublishError(AssetPublishCode.HUB_PUBLISH_FAILED, "The hub has no repository for this project")

    repo_id = HubRepoOrigin(repo=repo["repo"]).repo_id
    previous = entity.origin if isinstance(getattr(entity, "origin", None), HubRepoOrigin) else None
    last_tree = last_synced_tree(repo_id, rel_path) or (
        previous.tree if previous is not None and previous.rel_path == rel_path else None
    )
    mirror = HubRepoMirror(
        root=mirror_root(repo_id),
        clone_url=repo["clone_url"],
        branch=repo.get("default_branch") or "main",
        token=token,
    )
    synced = await sync_asset_with_hub(
        mirror=mirror,
        asset_root=real_asset,
        rel_path=rel_path,
        is_file=real_asset.is_file(),
        last_tree=last_tree,
        author=await _actor_author(actor),
        asset_typeid=str(entity.typeid),
    )

    payload = publish_asset_payload(project.id, entity.get_type(), entity.id, rel_path)
    try:
        hub_result = await hub_post("project", payload, action="publish_asset")
    except HubError as exc:
        raise AssetPublishError(
            AssetPublishCode.HUB_PUBLISH_FAILED,
            "The asset reached the project repository, but the hub could not register it",
            data={"rel_path": rel_path, "tree": synced.tree},
        ) from exc
    hub_result = hub_result or {}

    origin = HubRepoOrigin(
        repo=repo["repo"],
        rel_path=rel_path,
        head_commit=str(hub_result.get("head_commit") or synced.head_commit or ""),
        tree=str(hub_result.get("tree") or synced.tree),
    )
    remember_sync(
        repo_id,
        repo=origin.repo,
        rel_path=rel_path,
        tree=origin.tree,
        head_commit=origin.head_commit,
        local_path=str(real_asset),
    )
    entity.remote = True
    entity.origin = origin
    warning = None
    suppress = _SUPPRESS_STORE.set(True)
    try:
        await entity.save(actor, notify=False)
    except Exception:  # noqa: BLE001 — cloud publication succeeded; report cache repair need
        warning = "Asset was published, but the local cache could not be updated"
    finally:
        _SUPPRESS_STORE.reset(suppress)

    hub_asset = hub_result.get("asset")
    return AssetPublishResult(
        project={"id": project.id},
        asset=hub_asset if isinstance(hub_asset, dict) else {"type": entity.get_type(), "id": entity.id},
        git={
            "repo": repo["repo"],
            "rel_path": rel_path,
            "head_commit": entity.origin.head_commit,
            "tree": entity.origin.tree,
            "pushed": synced.pushed,
            "pulled_back": synced.pulled_back,
        },
        local_cache_warning=warning,
    )
