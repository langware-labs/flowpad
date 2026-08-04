"""A serialized, path-scoped Git publisher that preserves unrelated work."""

from __future__ import annotations

import asyncio
import os
import subprocess
import tempfile
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse
from weakref import WeakValueDictionary

from pydantic import SecretStr

from flow_sdk.assets.git_origin import PortableGitOrigin
from flow_sdk.assets.git_publish import (
    AssetGitReceipt,
    AssetPublishCode,
    AssetPublishError,
    GitAuthor,
)
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.utils.git import _git_token_auth, find_project_root
from flow_sdk.utils.git_identity import parse_git_origin_url

_REPO_LOCKS: "WeakValueDictionary[tuple[object, str], asyncio.Lock]" = WeakValueDictionary()


def _safe_git_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    return {**os.environ, "GIT_TERMINAL_PROMPT": "0", **(extra or {})}


class AssetGitWorktree:
    def __init__(self, repo_root: Path):
        self.repo_root = repo_root.resolve(strict=True)

    @classmethod
    def resolve(cls, asset_root: Path) -> "AssetGitWorktree":
        probe = Path(asset_root)
        if not probe.exists():
            probe = probe.parent
        root = find_project_root(str(probe))
        if not root:
            raise AssetPublishError(AssetPublishCode.NOT_GIT_BACKED, "Asset is not inside a Git checkout")
        return cls(Path(root))

    def _run(
        self,
        args: list[str],
        *,
        env: dict[str, str] | None = None,
        auth_token: str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        auth_args, auth_env = _git_token_auth(auth_token)
        command = ["git", *auth_args, *args]
        child_env = _safe_git_env({**(auth_env or {}), **(env or {})})
        return subprocess.run(
            command,
            cwd=self.repo_root,
            env=child_env,
            capture_output=True,
            text=True,
            check=False,
        )

    async def _git(
        self,
        args: list[str],
        *,
        env: dict[str, str] | None = None,
        auth_token: str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        return await asyncio.to_thread(self._run, args, env=env, auth_token=auth_token)

    async def _required(self, args: list[str], *, code: AssetPublishCode, auth_token: str | None = None) -> str:
        result = await self._git(args, auth_token=auth_token)
        if result.returncode != 0:
            raise AssetPublishError(code, "Git operation failed")
        return result.stdout.strip()

    async def _relation(self, local: str, remote: str) -> str:
        if local == remote:
            return "aligned"
        remote_ancestor = await self._git(["merge-base", "--is-ancestor", remote, local])
        if remote_ancestor.returncode == 0:
            return "ahead"
        local_ancestor = await self._git(["merge-base", "--is-ancestor", local, remote])
        return "behind" if local_ancestor.returncode == 0 else "diverged"

    async def _recognized_retry(self, remote: str, asset_typeid: TypeId) -> bool:
        count = await self._required(
            ["rev-list", "--count", f"{remote}..HEAD"],
            code=AssetPublishCode.BRANCH_AHEAD,
        )
        if count != "1":
            return False
        body = await self._required(["show", "-s", "--format=%B", "HEAD"], code=AssetPublishCode.BRANCH_AHEAD)
        trailer = f"FlowPad-Asset: {asset_typeid}"
        return any(line.strip() == trailer for line in body.splitlines())

    async def _commit_asset(
        self,
        *,
        asset_rel: str,
        asset_typeid: TypeId,
        author: GitAuthor,
    ) -> bool:
        handle = tempfile.NamedTemporaryFile(prefix="flowpad-asset-index-", delete=False)
        index_path = Path(handle.name)
        handle.close()
        index_path.unlink(missing_ok=True)
        index_env = {
            "GIT_INDEX_FILE": str(index_path),
            "GIT_AUTHOR_NAME": author.name,
            "GIT_AUTHOR_EMAIL": author.email,
            "GIT_COMMITTER_NAME": author.name,
            "GIT_COMMITTER_EMAIL": author.email,
        }
        try:
            read_tree = await self._git(["read-tree", "HEAD"], env=index_env)
            if read_tree.returncode != 0:
                raise AssetPublishError(AssetPublishCode.ORIGIN_INVALID, "Could not prepare the asset commit")
            add = await self._git(["add", "-A", "--", asset_rel], env=index_env)
            if add.returncode != 0:
                raise AssetPublishError(AssetPublishCode.ORIGIN_INVALID, "Could not stage the asset path")
            diff = await self._git(["diff", "--cached", "--quiet", "--", asset_rel], env=index_env)
            if diff.returncode == 0:
                return False
            if diff.returncode != 1:
                raise AssetPublishError(AssetPublishCode.ORIGIN_INVALID, "Could not inspect the asset change")
            message = (
                f"Publish FlowPad asset {asset_typeid}\n\n"
                f"FlowPad-Asset: {asset_typeid}\n"
                f"FlowPad-User: {author.typeid or author.email}"
            )
            commit = await self._git(
                ["-c", "commit.gpgSign=false", "commit", "-m", message],
                env=index_env,
            )
            if commit.returncode != 0:
                raise AssetPublishError(AssetPublishCode.ORIGIN_INVALID, "Could not commit the asset change")
            # HEAD moved while the user's real index did not. Align only this
            # asset path in the real index; every unrelated staged entry stays.
            reset_path = await self._git(["reset", "-q", "HEAD", "--", asset_rel])
            if reset_path.returncode != 0:
                raise AssetPublishError(AssetPublishCode.ORIGIN_INVALID, "Could not finalize the asset commit")
            return True
        finally:
            index_path.unlink(missing_ok=True)

    async def publish(
        self,
        *,
        asset_root: Path,
        asset_typeid: TypeId,
        token: SecretStr,
        author: GitAuthor,
    ) -> AssetGitReceipt:
        loop = asyncio.get_running_loop()
        key = (loop, str(self.repo_root))
        lock = _REPO_LOCKS.get(key)
        if lock is None:
            lock = asyncio.Lock()
            _REPO_LOCKS[key] = lock

        async with lock:
            lexical_asset = Path(asset_root).absolute()
            try:
                asset_rel_path = lexical_asset.relative_to(self.repo_root)
            except ValueError as exc:
                raise AssetPublishError(
                    AssetPublishCode.NOT_GIT_BACKED,
                    "Asset is outside its Git checkout",
                ) from exc
            asset_rel = PurePosixPath(*asset_rel_path.parts).as_posix()
            if not asset_rel or asset_rel == "." or ".git" in PurePosixPath(asset_rel).parts:
                raise AssetPublishError(AssetPublishCode.ORIGIN_INVALID, "Asset path is not publishable")
            real_probe = lexical_asset if lexical_asset.exists() else lexical_asset.parent
            try:
                real_probe.resolve(strict=True).relative_to(self.repo_root)
            except (OSError, ValueError) as exc:
                raise AssetPublishError(AssetPublishCode.ORIGIN_INVALID, "Asset path escapes its Git checkout") from exc

            branch = await self._required(
                ["symbolic-ref", "--quiet", "--short", "HEAD"],
                code=AssetPublishCode.ORIGIN_INVALID,
            )
            remote_url = await self._required(
                ["config", "--get", "remote.origin.url"],
                code=AssetPublishCode.ORIGIN_INVALID,
            )
            parsed = parse_git_origin_url(remote_url)
            url = urlparse(remote_url)
            if (
                not parsed
                or parsed[0] != "github"
                or url.scheme != "https"
                or (url.hostname or "").lower() != "github.com"
                or url.username is not None
                or url.password is not None
                or url.port is not None
                or bool(url.query or url.fragment)
            ):
                raise AssetPublishError(AssetPublishCode.ORIGIN_INVALID, "Only a GitHub origin can publish assets")
            provider, owner, name = parsed
            secret = token.get_secret_value()
            fetch = await self._git(
                ["fetch", "--no-tags", "origin", f"refs/heads/{branch}"],
                auth_token=secret,
            )
            if fetch.returncode != 0:
                raise AssetPublishError(AssetPublishCode.ORIGIN_INVALID, "Could not fetch the GitHub branch")
            local_head = await self._required(["rev-parse", "HEAD"], code=AssetPublishCode.ORIGIN_INVALID)
            remote_head = await self._required(["rev-parse", "FETCH_HEAD"], code=AssetPublishCode.ORIGIN_INVALID)
            relation = await self._relation(local_head, remote_head)
            retrying = relation == "ahead" and await self._recognized_retry(remote_head, asset_typeid)
            if relation == "ahead" and not retrying:
                raise AssetPublishError(AssetPublishCode.BRANCH_AHEAD, "Local branch has unpublished commits")
            if relation in {"behind", "diverged"}:
                raise AssetPublishError(AssetPublishCode.BRANCH_DIVERGED, "Local branch is not aligned with GitHub")
            if retrying:
                retry_status = await self._git(["status", "--porcelain", "--", asset_rel])
                if retry_status.returncode != 0 or retry_status.stdout.strip():
                    raise AssetPublishError(
                        AssetPublishCode.BRANCH_AHEAD,
                        "The pending asset commit no longer matches the working tree",
                    )

            changed = retrying or await self._commit_asset(
                asset_rel=asset_rel,
                asset_typeid=asset_typeid,
                author=author,
            )
            final_head = await self._required(["rev-parse", "HEAD"], code=AssetPublishCode.ORIGIN_INVALID)
            if changed:
                push = await self._git(
                    ["push", "origin", f"HEAD:refs/heads/{branch}"],
                    auth_token=secret,
                )
                if push.returncode != 0:
                    raise AssetPublishError(
                        AssetPublishCode.PUSH_REJECTED,
                        "GitHub rejected the asset commit",
                        data={"head_commit": final_head},
                    )
            origin = PortableGitOrigin(
                provider=provider,
                owner=owner,
                name=name,
                branch=branch,
                head_commit=final_head,
                rel_path=asset_rel,
            )
            return AssetGitReceipt(
                changed=changed,
                repo_root=self.repo_root,
                branch=branch,
                head_commit=final_head,
                origin=origin,
            )
