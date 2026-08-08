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
    GitErrorCode.PUSH_REJECTED: AssetPublishCode.PUSH_REJECTED,
    GitErrorCode.PATH_ESCAPES_REPO: AssetPublishCode.ORIGIN_INVALID,
    GitErrorCode.COMMAND_FAILED: AssetPublishCode.ORIGIN_INVALID,
}


def as_publish_error(error: GitError) -> AssetPublishError:
    """Map a mechanics failure onto the asset contract, keeping it output-free."""
    code = _GIT_ERROR_TO_PUBLISH.get(error.code, AssetPublishCode.ORIGIN_INVALID)
    return AssetPublishError(code, "Git operation failed", data=error.data)


async def resolve_asset_folder(asset_root: Path, *, token: str | None = None) -> GitFolder:
    """The checkout containing ``asset_root``."""
    try:
        return await GitFolder.discover(asset_root, token=token)
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


async def _is_recognized_retry(folder: GitFolder, remote_head: str, asset_typeid: TypeId) -> bool:
    """True when the single unpushed commit is our own previous publish attempt.

    Without this, a publish whose push failed after committing would be stuck
    forever behind the "local branch has unpublished commits" guard.
    """
    count = await folder.required("rev-list", "--count", f"{remote_head}..HEAD")
    if count != "1":
        return False
    body = await folder.required("show", "-s", "--format=%B", "HEAD")
    return any(line.strip() == f"FlowPad-Asset: {asset_typeid}" for line in body.splitlines())


async def _push(folder: GitFolder, refspecs: list[str], head_commit: str) -> None:
    """Publish commits, keeping the failure specific enough to act on.

    A push that is *refused* or whose upstream is unreachable is
    ``PUSH_REJECTED`` — the commit exists locally and did not reach GitHub, and
    ``head_commit`` is what lets the retry path recognise its own work. But a
    credential failure must NOT be flattened into that: it maps through the
    table to ``GITHUB_NOT_CONNECTED``, so a user whose token expired mid-publish
    is told to reconnect rather than to resolve a conflict that does not exist.
    """
    try:
        await folder.push(refspec=refspecs)
    except GitError as exc:
        if exc.code in (GitErrorCode.PUSH_REJECTED, GitErrorCode.UPSTREAM_UNAVAILABLE):
            raise AssetPublishError(
                AssetPublishCode.PUSH_REJECTED,
                "GitHub rejected the asset commit",
                data={"head_commit": head_commit, **exc.data},
            ) from exc
        exc.data.setdefault("head_commit", head_commit)
        raise


async def publish_asset(
    *,
    asset_root: Path,
    asset_typeid: TypeId,
    token: SecretStr,
    author: GitAuthor,
    folder: GitFolder | None = None,
    cloud_branch: str = CLOUD_BRANCH,
) -> AssetGitReceipt:
    """Commit the asset path, push it, and advance the cloud branch."""
    secret = token.get_secret_value()
    folder = folder or await resolve_asset_folder(asset_root, token=secret)

    try:
        async with folder.lock():
            asset_rel = _asset_rel(folder, asset_root)

            branch = await folder.current_branch()
            if not branch:
                raise AssetPublishError(AssetPublishCode.ORIGIN_INVALID, "Cannot publish from a detached HEAD")
            remote_url = await folder.get_remote_url()
            if not remote_url:
                raise AssetPublishError(AssetPublishCode.ORIGIN_INVALID, "Checkout has no origin remote")
            owner, name = validate_github_remote(remote_url)

            local_head = await folder.head()
            remote_head = await folder.remote_head(branch)
            relation = await folder.relation(local_head, remote_head)
            retrying = relation == "ahead" and await _is_recognized_retry(folder, remote_head, asset_typeid)
            if relation == "ahead" and not retrying:
                raise AssetPublishError(AssetPublishCode.BRANCH_AHEAD, "Local branch has unpublished commits")
            if relation in {"behind", "diverged"}:
                raise AssetPublishError(AssetPublishCode.BRANCH_DIVERGED, "Local branch is not aligned with GitHub")
            if retrying and await folder.status_paths(asset_rel):
                raise AssetPublishError(
                    AssetPublishCode.BRANCH_AHEAD,
                    "The pending asset commit no longer matches the working tree",
                )

            committed_head = (
                None
                if retrying
                else await folder.commit(
                    [asset_rel],
                    f"Publish FlowPad asset {asset_typeid}",
                    author=author,
                    trailers=[
                        f"FlowPad-Asset: {asset_typeid}",
                        f"FlowPad-User: {author.typeid or author.email}",
                    ],
                    scoped_index=True,
                )
            )
            changed = retrying or committed_head is not None
            final_head = committed_head or local_head

            # One invocation for both refs: one connection, one credential
            # handshake, and no window where the user's branch advanced but
            # flow-cloud did not. The cloud branch is pushed even when nothing
            # changed — the asset commit may already exist while flow-cloud has
            # never been created.
            refspecs = [f"HEAD:refs/heads/{cloud_branch}"]
            if changed:
                refspecs.insert(0, f"HEAD:refs/heads/{branch}")
            await _push(folder, refspecs, final_head)

            return AssetGitReceipt(
                changed=changed,
                repo_root=folder.root,
                branch=cloud_branch,
                head_commit=final_head,
                origin=PortableGitOrigin(
                    provider="github",
                    owner=owner,
                    name=name,
                    branch=cloud_branch,
                    head_commit=final_head,
                    rel_path=asset_rel,
                ),
            )
    except GitError as exc:
        raise as_publish_error(exc) from exc
