"""Publishing one asset to GitHub — the policy on top of :class:`GitFolder`.

This replaces ``AssetGitWorktree``. The git mechanics moved to
``flow_sdk.utils.git_folder``; what stayed here is everything that is a *rule
about assets* rather than a rule about git:

* only a canonical GitHub HTTPS origin may publish,
* the local branch must be aligned with its remote (with one recognized retry),
* the commit is scoped to the asset path and carries FlowPad trailers,
* publishing advances the **cloud branch** as well as the user's own branch.

That last one is why shared links are stable. The user's ``main`` moves whenever
they work; ``flow-cloud`` moves only when they publish. Anything consuming a
published asset pins to ``flow-cloud`` and is therefore unaffected by unrelated
pushes — which is what removes the head-drift failure the Hub used to hit on
every read.
"""

from __future__ import annotations

from pathlib import Path, PurePosixPath

from pydantic import SecretStr

from flow_sdk.assets.git_origin import PortableGitOrigin
from flow_sdk.assets.git_publish import AssetGitReceipt, AssetPublishCode, AssetPublishError, GitAuthor
from flow_sdk.fs_store.type_id import TypeId
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


async def resolve_asset_folder(asset_root: Path, *, token: str | None = None) -> GitFolder:
    """The checkout containing ``asset_root``.

    The executor comes from the local ComputeNode — the only way to obtain one.
    Publishing reads and commits the user's own working copy, so the node is
    ``@local`` by definition; making that explicit is what stops "where does git
    run" from being answered by a silent default.
    """
    from flow_sdk.builtin.faas.compute_node import ComputeNode  # noqa: PLC0415

    node = await ComputeNode.get_local()
    try:
        return await GitFolder.discover(asset_root, executor=node.get_command_executor(), token=token)
    except GitError as exc:
        raise AssetPublishError(AssetPublishCode.NOT_GIT_BACKED, "Asset is not inside a Git checkout") from exc


def _asset_rel(folder: GitFolder, asset_root: Path) -> str:
    lexical = Path(asset_root).absolute()
    try:
        relative = lexical.relative_to(folder.root)
    except ValueError as exc:
        raise AssetPublishError(AssetPublishCode.NOT_GIT_BACKED, "Asset is outside its Git checkout") from exc
    rel = PurePosixPath(*relative.parts).as_posix()
    if not rel or rel == "." or ".git" in PurePosixPath(rel).parts:
        raise AssetPublishError(AssetPublishCode.ORIGIN_INVALID, "Asset path is not publishable")
    probe = lexical if lexical.exists() else lexical.parent
    try:
        probe.resolve(strict=True).relative_to(folder.root.resolve())
    except (OSError, ValueError) as exc:
        raise AssetPublishError(AssetPublishCode.ORIGIN_INVALID, "Asset path escapes its Git checkout") from exc
    return rel


async def publish_asset(
    *,
    asset_root: Path,
    asset_typeid: TypeId,
    token: SecretStr,
    author: GitAuthor,
    folder: GitFolder | None = None,
    cloud_branch: str = CLOUD_BRANCH,
) -> AssetGitReceipt:
    """Publish one asset. Everything here is an ASSET rule; the git choreography
    lives in :meth:`GitFolder.publish`."""
    secret = token.get_secret_value()
    folder = folder or await resolve_asset_folder(asset_root, token=secret)

    try:
        async with folder.lock():
            asset_rel = _asset_rel(folder, asset_root)
            remote_url = await folder.get_remote_url()
            if not remote_url:
                raise AssetPublishError(AssetPublishCode.ORIGIN_INVALID, "Checkout has no origin remote")
            # Asset policy, not a git rule: only a canonical GitHub origin may
            # publish. Checked before any network call so a bad origin fails fast.
            owner, name = validate_github_remote(remote_url)

            receipt = await folder.publish(
                asset_rel,
                message=f"Publish FlowPad asset {asset_typeid}",
                author=author,
                trailers=[
                    f"FlowPad-Asset: {asset_typeid}",
                    f"FlowPad-User: {author.typeid or author.email}",
                ],
                also_advance=cloud_branch,
                retry_marker=f"FlowPad-Asset: {asset_typeid}",
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
