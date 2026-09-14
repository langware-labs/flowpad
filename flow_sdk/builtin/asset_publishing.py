"""Internal orchestration for :func:`publish_git_asset`."""

from __future__ import annotations

from pathlib import Path

from flow_sdk.assets.git_origin import PortableGitOrigin
from flow_sdk.assets.git_publish import (
    AssetGitReceipt,
    AssetPublishCode,
    AssetPublishError,
    AssetPublishResult,
    GitAuthor,
    asset_relative_path,
)
from flow_sdk.assets.projection import PORTABLE_ASSET_CONTRACT_VERSION
from flow_sdk.builtin.asset_projection import project_asset_tree
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.utils.command_executor import CommandExecutor
from flow_sdk.utils.git_folder import GitError, GitErrorCode, GitFolder, validate_github_remote

#: The branch a published asset is pinned to. Advanced only by publishing.
CLOUD_BRANCH = "flow-cloud"

_GIT_ERROR_TO_PUBLISH: dict[GitErrorCode, AssetPublishCode] = {
    GitErrorCode.NOT_A_REPO: AssetPublishCode.NOT_GIT_BACKED,
    GitErrorCode.REMOTE_INVALID: AssetPublishCode.ORIGIN_INVALID,
    GitErrorCode.REMOTE_MISMATCH: AssetPublishCode.ORIGIN_INVALID,
    GitErrorCode.BRANCH_INVALID: AssetPublishCode.ORIGIN_INVALID,
    GitErrorCode.BRANCH_NOT_FOUND: AssetPublishCode.ORIGIN_INVALID,
    GitErrorCode.AUTH_REQUIRED: AssetPublishCode.GITHUB_NOT_CONNECTED,
    GitErrorCode.AUTH_FAILED: AssetPublishCode.GITHUB_NOT_CONNECTED,
    GitErrorCode.UPSTREAM_UNAVAILABLE: AssetPublishCode.ORIGIN_INVALID,
    GitErrorCode.ORIGIN_OUT_OF_DATE: AssetPublishCode.BRANCH_DIVERGED,
    GitErrorCode.DETACHED_HEAD: AssetPublishCode.ORIGIN_INVALID,
    GitErrorCode.BRANCH_AHEAD: AssetPublishCode.BRANCH_AHEAD,
    GitErrorCode.BRANCH_DIVERGED: AssetPublishCode.BRANCH_DIVERGED,
    GitErrorCode.PUSH_REJECTED: AssetPublishCode.PUSH_REJECTED,
    GitErrorCode.PATH_ESCAPES_REPO: AssetPublishCode.ORIGIN_INVALID,
    GitErrorCode.COMMAND_FAILED: AssetPublishCode.ORIGIN_INVALID,
}


def as_publish_error(error: GitError) -> AssetPublishError:
    """Map a mechanics failure onto the asset contract, keeping it output-free."""
    code = _GIT_ERROR_TO_PUBLISH.get(error.code, AssetPublishCode.ORIGIN_INVALID)
    return AssetPublishError(code, "Git operation failed", data=error.data)


async def resolve_asset_folder(
    asset_root: Path,
    *,
    executor: CommandExecutor,
    token: str | None = None,
) -> GitFolder:
    """The checkout containing ``asset_root``.

    The caller supplies the executor for the intended filesystem. Asset
    utilities never look up a compute node or choose a runtime implicitly.
    """
    try:
        return await GitFolder.discover(asset_root, executor=executor, token=token)
    except GitError as exc:
        raise AssetPublishError(AssetPublishCode.NOT_GIT_BACKED, "Asset is not inside a Git checkout") from exc




async def publish_asset(
    *,
    asset_root: Path,
    asset_typeid: TypeId,
    author: GitAuthor,
    folder: GitFolder,
    cloud_branch: str = CLOUD_BRANCH,
) -> AssetGitReceipt:
    """Publish one asset. Everything here is an ASSET rule; the git choreography
    lives in :meth:`GitFolder.publish`.

    The supplied folder already carries its executor and checkout identity.
    """
    try:
        async with folder.lock():
            asset_rel = asset_relative_path(folder.root, asset_root)
            remote_url = await folder.get_remote_url()
            if not remote_url:
                raise AssetPublishError(AssetPublishCode.ORIGIN_INVALID, "Checkout has no origin remote")
            # Asset policy, not a git rule: only a canonical GitHub origin may
            # publish. Checked before any network call so a bad origin fails fast.
            owner, name = validate_github_remote(remote_url)

            # One literal: the trailer that identifies this asset's commit is
            # the same string the retry path recognises its own pending commit
            # by. Two copies drifting apart would silently strand the retry.
            asset_trailer = f"FlowPad-Asset: {asset_typeid}"
            receipt = await folder.publish(
                asset_rel,
                message=f"Publish FlowPad asset {asset_typeid}",
                author=author,
                trailers=[
                    asset_trailer,
                    f"FlowPad-User: {author.typeid or author.email}",
                ],
                also_advance=cloud_branch,
                retry_marker=asset_trailer,
            )

            return AssetGitReceipt(
                changed=receipt.changed,
                repo_root=folder.root,
                branch=cloud_branch,
                head_commit=receipt.head_commit,
                origin=PortableGitOrigin(
                    provider="github",
                    owner=owner,
                    name=name,
                    branch=cloud_branch,
                    head_commit=receipt.head_commit,
                    rel_path=asset_rel,
                ),
            )
    except GitError as exc:
        raise as_publish_error(exc) from exc


async def owning_project(entity):
    """The Project that owns a file-backed asset, or None.

    Public because the share orchestrator needs the same answer before it
    touches git — two definitions of "which project is this asset in" would
    let the CLI publish under a different project than the one it gated on.
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


async def publish_git_asset(entity, actor: TypeId) -> AssetPublishResult:
    from flow_sdk.builtin.faas.compute_node import ComputeNode  # noqa: PLC0415
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.cli.auth.credentials import load_credentials  # noqa: PLC0415
    from flow_sdk.cloud_client.client import ApiConfig, FlowpadClient  # noqa: PLC0415
    from flow_sdk.core.entity.entity_model import _SUPPRESS_STORE  # noqa: PLC0415
    from flow_sdk.core.oauth.github_credentials import get_github_token  # noqa: PLC0415
    from flow_sdk.core.urls.service_urls import build_hub_url  # noqa: PLC0415

    info = SchemaRegistry.get(entity.get_type())
    if info is None or not info.git_publishable or not getattr(entity, "asset_ref", None):
        raise AssetPublishError(AssetPublishCode.NOT_GIT_BACKED, "Entity is not a Git-publishable asset")

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

    asset_ref = Path(entity.asset_ref)
    asset_root = info.storage_root_for(asset_ref)
    try:
        real_asset = asset_root.resolve(strict=True)
        real_mount = Path(mount_value).resolve(strict=True)
    except OSError as exc:
        raise AssetPublishError(AssetPublishCode.NOT_GIT_BACKED, "Asset or Project mount is unavailable") from exc
    if not real_asset.is_relative_to(real_mount):
        raise AssetPublishError(AssetPublishCode.NOT_GIT_BACKED, "Asset is outside its owning Project")

    github_token = await get_github_token(actor)
    if not github_token:
        raise AssetPublishError(AssetPublishCode.GITHUB_NOT_CONNECTED, "Connect GitHub before publishing an asset")

    # Resolved WITH the token so the folder handed to publish_asset is already
    # authenticated — the alternative was reaching into its private state.
    node = await ComputeNode.get_local()
    folder = await resolve_asset_folder(real_asset, executor=node.get_command_executor(), token=github_token)
    if not real_asset.is_relative_to(folder.root):
        raise AssetPublishError(AssetPublishCode.NOT_GIT_BACKED, "Asset is outside its Git checkout")
    credentials = load_credentials()
    if not credentials or not credentials.api_key:
        raise AssetPublishError(AssetPublishCode.HUB_PUBLISH_FAILED, "Cloud login required")

    receipt = await publish_asset(
        asset_root=real_asset,
        asset_typeid=entity.typeid,
        author=await _actor_author(actor),
        folder=folder,
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

    from flow_sdk.fs_store.origin.git_origin import GitOrigin  # noqa: PLC0415

    entity.remote = True
    entity.origin = GitOrigin.model_validate(receipt.origin.model_dump(mode="json"))
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
