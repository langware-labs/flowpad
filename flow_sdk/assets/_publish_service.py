"""Internal orchestration for :func:`publish_git_asset`."""

from __future__ import annotations

from pathlib import Path

from pydantic import SecretStr

from flow_sdk.assets.git_publish import (
    AssetPublishCode,
    AssetPublishError,
    AssetPublishResult,
    GitAuthor,
)
from flow_sdk.assets.git_worktree import AssetGitWorktree
from flow_sdk.assets.projection import PORTABLE_ASSET_CONTRACT_VERSION, project_asset_tree
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.fs_store.type_id import TypeId


async def _owning_project(entity):
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


async def publish_git_asset_impl(entity, actor: TypeId) -> AssetPublishResult:
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.cli.auth.credentials import load_credentials  # noqa: PLC0415
    from flow_sdk.cloud_client.client import ApiConfig, FlowpadClient  # noqa: PLC0415
    from flow_sdk.core.entity.entity_model import _SUPPRESS_STORE  # noqa: PLC0415
    from flow_sdk.core.oauth.github_credentials import get_github_token  # noqa: PLC0415
    from flow_sdk.core.urls.service_urls import build_hub_url  # noqa: PLC0415

    info = SchemaRegistry.get(entity.get_type())
    if info is None or not info.git_publishable or not getattr(entity, "asset_ref", None):
        raise AssetPublishError(AssetPublishCode.NOT_GIT_BACKED, "Entity is not a Git-publishable asset")

    project = await _owning_project(entity)
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

    asset_ref = Path(entity.asset_ref)
    asset_root = info.folder_for(asset_ref) if info.main_layout == "folder" else asset_ref
    try:
        real_asset = asset_root.resolve(strict=True)
        real_mount = Path(mount_value).resolve(strict=True)
    except OSError as exc:
        raise AssetPublishError(AssetPublishCode.NOT_GIT_BACKED, "Asset or Project mount is unavailable") from exc
    if not real_asset.is_relative_to(real_mount):
        raise AssetPublishError(AssetPublishCode.NOT_GIT_BACKED, "Asset is outside its owning Project")

    worktree = AssetGitWorktree.resolve(real_asset)
    if not real_asset.is_relative_to(worktree.repo_root):
        raise AssetPublishError(AssetPublishCode.NOT_GIT_BACKED, "Asset is outside its Git checkout")

    github_token = await get_github_token(actor)
    if not github_token:
        raise AssetPublishError(AssetPublishCode.GITHUB_NOT_CONNECTED, "Connect GitHub before publishing an asset")
    credentials = load_credentials()
    if not credentials or not credentials.api_key:
        raise AssetPublishError(AssetPublishCode.HUB_PUBLISH_FAILED, "Cloud login required")

    receipt = await worktree.publish(
        asset_root=real_asset,
        asset_typeid=entity.typeid,
        token=SecretStr(github_token),
        author=await _actor_author(actor),
    )
    projection = project_asset_tree(
        entity_type=entity.get_type(),
        expected_id=entity.id,
        checkout_root=receipt.repo_root,
        origin=receipt.origin,
    )
    payload = {
        "contract_version": PORTABLE_ASSET_CONTRACT_VERSION,
        "project": {"id": project.id},
        "asset": projection.model_dump(mode="json"),
        "git_origin": receipt.origin.model_dump(mode="json"),
    }
    try:
        async with FlowpadClient(ApiConfig.from_env(), api_key=credentials.api_key) as client:
            hub_result = await client.post(build_hub_url("project", action="publish_asset"), payload)
    except Exception as exc:  # noqa: BLE001 — expose only safe, typed coordinates
        raise AssetPublishError(
            AssetPublishCode.HUB_PUBLISH_FAILED,
            "GitHub was updated, but the Hub could not register the asset",
            data={
                "head_commit": receipt.head_commit,
                "git_origin": receipt.origin.model_dump(mode="json"),
            },
        ) from exc

    entity.remote = True
    entity.git_origin = receipt.origin.model_dump(mode="json")
    warning = None
    token = _SUPPRESS_STORE.set(True)
    try:
        await entity.save(actor, notify=False)
    except Exception:  # noqa: BLE001 — cloud publication succeeded; report cache repair need
        warning = "Asset was published, but the local cache could not be updated"
    finally:
        _SUPPRESS_STORE.reset(token)

    hub_asset = hub_result.get("asset") if isinstance(hub_result, dict) else None
    return AssetPublishResult(
        project={"id": project.id},
        asset=hub_asset if isinstance(hub_asset, dict) else projection.model_dump(mode="json"),
        git=receipt.model_dump(mode="json"),
        local_cache_warning=warning,
    )
