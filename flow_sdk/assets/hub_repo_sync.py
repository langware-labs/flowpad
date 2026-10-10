"""Publish an asset into its project's hub-hosted git repository.

A linked project owns one repository on the hub that grows as a reflection of
the project folder: every published asset lives there at its project-relative
path. This module keeps a private MIRROR of that repository per project (under
the instance directory) and moves one asset through it:

1. sync the mirror to the hub;
2. if the hub changed this asset since the version we last synced (``tree``)
   and we did not change it locally, PULL the hub's version back into the
   project folder; if both sides changed it, refuse (``ASSET_CONFLICT``);
3. otherwise copy the local asset in, commit, and push.

The user's own folder is never a git repo requirement and is never pushed: the
mirror is the only checkout, and the hub is the only remote. Git authenticates
with the user's hub token as a Bearer header passed through the environment
(never argv, never a remote URL).
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from flow_sdk.assets.git_publish import AssetPublishCode, AssetPublishError, GitAuthor
from flow_sdk.instances.atomic import locked, read_json, write_json_atomic
from flow_sdk.stream_inbox._locks import keyed_loop_lock, new_registry
from flow_sdk.utils.git_folder import KEEP_FILE
from flow_sdk.utils.git_usable import git_usable

logger = logging.getLogger(__name__)

#: One lock per mirror root. Weak-valued (``stream_inbox/_locks``): it lives only while a
#: sync holds or awaits it, so the registry does not keep one lock per root ever synced.
_locks = new_registry()


def mirror_root(repo_id: str) -> Path:
    """This machine's working mirror of one hub repo (keyed by the repo, so anything
    holding a ``HubRepoOrigin`` can find it without resolving the project)."""
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    return Path(get_instance_settings().instance_dir) / "hub_git" / "mirrors" / repo_id


# ── this machine's sync state ────────────────────────────────────────────
#
# What this desk last agreed with the hub about, per asset: the tree it last
# published or pulled. It is the ONLY record that tells "the hub changed it" from
# "I changed it", so it lives beside the mirror, in a file no re-index touches —
# an entity's ``origin`` is re-derived from disk and cannot hold it.


def _state_file(repo_id: str) -> Path:
    return mirror_root(repo_id).parent.parent / "state" / f"{repo_id}.json"


def remember_sync(repo_id: str, *, repo: str, rel_path: str, tree: str, head_commit: str, local_path: str) -> None:
    path = _state_file(repo_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with locked(path.with_suffix(".lock")):
        state = read_json(path)
        state.setdefault("assets", {})[rel_path] = {
            "repo": repo,
            "tree": tree,
            "head_commit": head_commit,
            "local_path": local_path,
        }
        write_json_atomic(path, state)


def last_synced_tree(repo_id: str, rel_path: str) -> str | None:
    entry = read_json(_state_file(repo_id)).get("assets", {}).get(rel_path) or {}
    return entry.get("tree") or None


def hub_origin_for_path(local_path: Path):
    """The ``HubRepoOrigin`` this desk last synced for the asset at ``local_path``, or None."""
    from flow_sdk.fs_store.origin.hub_repo_origin import HubRepoOrigin  # noqa: PLC0415

    target = str(Path(local_path).resolve())
    state_dir = mirror_root("x").parent.parent / "state"
    for path in sorted(state_dir.glob("*.json")) if state_dir.is_dir() else []:
        for rel, entry in (read_json(path).get("assets") or {}).items():
            if entry.get("local_path") == target:
                return HubRepoOrigin(
                    repo=entry["repo"], rel_path=rel, head_commit=entry.get("head_commit", ""), tree=entry["tree"]
                )
    return None


def hub_origin_of(entity, folder: Path | None):
    """An asset's hub-repo origin: its own field, else this desk's sync state for ``folder``.

    The field is lost on a re-index (it is not derivable from disk); the sync state is not.
    """
    from flow_sdk.fs_store.origin.hub_repo_origin import HubRepoOrigin  # noqa: PLC0415

    origin = getattr(entity, "origin", None)
    if isinstance(origin, HubRepoOrigin):
        return origin
    return hub_origin_for_path(folder) if folder is not None else None


def published_origin(entity):
    """An asset's hub-repo origin once it has been published into its project's repo, else None — whatever
    form its row holds the asset at (the folder for most types, the main file for some)."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    info = SchemaRegistry.get(entity.get_type())
    ref = getattr(entity, "asset_ref", None)
    return hub_origin_of(entity, info.storage_root_for(Path(str(ref))) if info is not None and ref else None)


def local_tree(mirror: Path, worktree: Path, rel_path: str) -> str | None:
    """The git object id ``worktree/rel_path`` would have — computed in a throwaway index
    against ``mirror``'s object store, so the project folder never needs to be a repo."""
    import subprocess  # noqa: PLC0415
    import tempfile  # noqa: PLC0415

    from flow_sdk.utils.git_usable import git_usable  # noqa: PLC0415

    if not git_usable():  # a Mac without the Command Line Tools: git would open Apple's installer dialog
        return None
    with tempfile.TemporaryDirectory() as scratch:
        env = {**os.environ, "GIT_INDEX_FILE": str(Path(scratch) / "index"), "GIT_TERMINAL_PROMPT": "0"}
        base = ["git", "--git-dir", str(mirror / ".git"), "--work-tree", str(worktree)]
        added = subprocess.run([*base, "add", "-A", "--", rel_path], env=env, capture_output=True, text=True)
        if added.returncode != 0:
            return None
        tree = subprocess.run([*base, "write-tree"], env=env, capture_output=True, text=True).stdout.strip()
        found = subprocess.run(
            [*base, "rev-parse", "--verify", "--quiet", f"{tree}:{rel_path}"], env=env, capture_output=True, text=True
        )
        return found.stdout.strip() or None


def _lock(root: Path) -> asyncio.Lock:
    return keyed_loop_lock(_locks, str(root))


def _git_env(token: str) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_CONFIG_")}
    env.update(
        {
            "GIT_TERMINAL_PROMPT": "0",
            "LC_ALL": "C",
            "GIT_CONFIG_COUNT": "2",
            # The hub token rides as a header, set per process: never in argv or .git/config.
            "GIT_CONFIG_KEY_0": "http.extraHeader",
            "GIT_CONFIG_VALUE_0": f"Authorization: Bearer {token}",
            # No keychain prompt and no stored GitHub credential is ever offered to the hub.
            "GIT_CONFIG_KEY_1": "credential.helper",
            "GIT_CONFIG_VALUE_1": "",
        }
    )
    return env


@dataclass
class HubRepoMirror:
    root: Path
    clone_url: str
    branch: str
    token: str

    async def git(self, *args: str, check: bool = True, cwd: Path | None = None) -> tuple[int, str]:
        if not git_usable():
            # A Mac without the Command Line Tools has a git STUB, not a missing binary: it would open Apple's
            # installer dialog instead of raising FileNotFoundError. Say the same thing the missing case says.
            raise AssetPublishError(
                AssetPublishCode.HUB_PUBLISH_FAILED,
                "Git is not installed on this machine — install it from Flowpad's setup, then try again",
            )
        try:
            proc = await asyncio.create_subprocess_exec(
                "git",
                *args,
                cwd=str(cwd or self.root),
                env=_git_env(self.token),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as exc:
            # A fresh machine (a new Windows install) may have no git at all; say so,
            # rather than the bare "[WinError 2] The system cannot find the file".
            raise AssetPublishError(
                AssetPublishCode.HUB_PUBLISH_FAILED,
                "Git is not installed on this machine — install it from Flowpad's setup, then try again",
            ) from exc
        out, err = await proc.communicate()
        text = (out or b"").decode(errors="replace").strip()
        if check and proc.returncode != 0:
            detail = (err or b"").decode(errors="replace").strip() or text
            raise AssetPublishError(
                AssetPublishCode.HUB_PUBLISH_FAILED, f"git {args[0]} against the hub failed", data={"detail": detail}
            )
        return proc.returncode or 0, text

    async def sync(self) -> None:
        """Make the mirror an exact copy of the hub's branch (or an unborn branch when empty)."""
        if not (self.root / ".git").is_dir():
            self.root.parent.mkdir(parents=True, exist_ok=True)
            if self.root.exists():
                shutil.rmtree(self.root)
            await self.git("clone", "-q", "--no-checkout", self.clone_url, str(self.root), cwd=self.root.parent)
        else:
            await self.git("remote", "set-url", "origin", self.clone_url)
        await self.git("fetch", "-q", "--prune", "origin")
        code, _ = await self.git("rev-parse", "--verify", "--quiet", f"refs/remotes/origin/{self.branch}", check=False)
        if code == 0:
            await self.git("checkout", "-q", "-B", self.branch, f"origin/{self.branch}")
            await self.git("reset", "-q", "--hard", f"origin/{self.branch}")
        else:
            await self.git("checkout", "-q", "--orphan", self.branch, check=False)
            await self.git("rm", "-rq", "--cached", "--ignore-unmatch", ".", check=False)
        await self.git("clean", "-qfdx")

    async def tree_at_head(self, rel_path: str) -> str | None:
        code, out = await self.git("rev-parse", "--verify", "--quiet", f"HEAD:{rel_path}", check=False)
        return out if code == 0 and out else None

    async def staged_tree(self, rel_path: str) -> str | None:
        """The object id ``rel_path`` WOULD have if the working tree were committed now."""
        await self.git("add", "-A", "--", rel_path)
        _, tree = await self.git("write-tree")
        code, out = await self.git("rev-parse", "--verify", "--quiet", f"{tree}:{rel_path}", check=False)
        return out if code == 0 and out else None

    async def discard(self, rel_path: str) -> None:
        await self.git("reset", "-q", "--", rel_path, check=False)
        await self.git("checkout", "-q", "HEAD", "--", rel_path, check=False)
        await self.git("clean", "-qfd", "--", rel_path, check=False)

    async def commit_and_push(self, message: str, author: GitAuthor, trailers: list[str]) -> str:
        body = "\n".join([message, "", *trailers])
        await self.git("-c", f"user.name={author.name}", "-c", f"user.email={author.email}", "commit", "-q", "-m", body)
        code, _ = await self.git("push", "-q", "origin", f"HEAD:refs/heads/{self.branch}", check=False)
        if code != 0:
            raise AssetPublishError(
                AssetPublishCode.ASSET_CONFLICT, "The project repository moved while publishing; publish again"
            )
        _, head = await self.git("rev-parse", "HEAD")
        return head


def _replace(source: Path, target: Path, *, is_file: bool) -> None:
    """Make ``target`` hold exactly ``source`` (a file, or a folder's files)."""
    if is_file:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        return
    if target.exists():
        shutil.rmtree(target)
    # The project's own ignore rules hold here too, not only the mirror's: a file the source checkout
    # keeps out of git is not published by copying it into another one.
    from flow_sdk.utils.git_ignore import ignored_under, is_under  # noqa: PLC0415

    # The asset itself being ignored is the person's explicit publish; what is ignored INSIDE it stays home.
    ignored = ignored_under(source) - {Path(source).resolve()}
    base = shutil.ignore_patterns(".git", KEEP_FILE)

    def _ignore(directory: str, names: list[str]) -> set[str]:
        skipped = set(base(directory, names))
        skipped |= {n for n in names if is_under(Path(directory) / n, ignored)}
        return skipped

    shutil.copytree(source, target, ignore=_ignore)


@dataclass(frozen=True)
class HubRepoSync:
    """What a publish did: the asset's new version and whether the hub's edits were pulled back."""

    head_commit: str | None
    tree: str
    pushed: bool
    pulled_back: bool


async def sync_asset_with_hub(
    *,
    mirror: HubRepoMirror,
    asset_root: Path,
    rel_path: str,
    is_file: bool,
    last_tree: str | None,
    author: GitAuthor,
    asset_typeid: str,
) -> HubRepoSync:
    """Reconcile one asset between the project folder and the hub repo (see module docstring)."""
    rel = PurePosixPath(rel_path).as_posix()
    target = mirror.root.joinpath(*PurePosixPath(rel).parts)
    async with _lock(mirror.root):
        await mirror.sync()
        upstream = await mirror.tree_at_head(rel)
        await asyncio.to_thread(_replace, asset_root, target, is_file=is_file)
        local = await mirror.staged_tree(rel)
        if local is None:
            raise AssetPublishError(AssetPublishCode.NOT_GIT_BACKED, "The asset has no content to publish")

        hub_changed = upstream is not None and last_tree is not None and upstream != last_tree
        if hub_changed and local != upstream:
            if local != last_tree:
                await mirror.discard(rel)
                raise AssetPublishError(
                    AssetPublishCode.ASSET_CONFLICT,
                    "This asset was changed on the hub and here since it was last published",
                    data={"rel_path": rel},
                )
            # Only the hub changed it: bring the hub's version home, nothing to push.
            await mirror.discard(rel)
            await asyncio.to_thread(_replace, target, asset_root, is_file=is_file)
            _, head = await mirror.git("rev-parse", "HEAD")
            return HubRepoSync(head_commit=head, tree=upstream, pushed=False, pulled_back=True)

        if local == upstream:
            _, head = await mirror.git("rev-parse", "--verify", "--quiet", "HEAD", check=False)
            return HubRepoSync(head_commit=head or None, tree=local, pushed=False, pulled_back=False)

        head = await mirror.commit_and_push(
            f"Publish FlowPad asset {asset_typeid}",
            author,
            [f"FlowPad-Asset: {asset_typeid}", f"FlowPad-User: {author.typeid or author.email}"],
        )
        return HubRepoSync(head_commit=head, tree=local, pushed=True, pulled_back=False)


@dataclass
class HubRepoCheckout(HubRepoMirror):
    """A WORKING checkout of a hub-hosted repo — a shared project on a recipient.

    Unlike the mirror (a cache nothing else writes, so it hard-resets and cleans),
    this folder is the user's: it is cloned once, later only fast-forwarded, and
    never reset, cleaned or deleted. A pull that cannot fast-forward (local work)
    is left alone — the project still opens on what is there.
    """

    async def checkout(self) -> None:
        if not (self.root / ".git").is_dir():
            if self.root.exists() and any(self.root.iterdir()):
                raise RuntimeError(f"{self.root} is not empty and not a checkout of this repository")
            self.root.parent.mkdir(parents=True, exist_ok=True)
            await self.git("clone", "-q", "--branch", self.branch, self.clone_url, str(self.root), cwd=self.root.parent)
            return
        await self.git("remote", "set-url", "origin", self.clone_url)
        code, out = await self.git("pull", "-q", "--ff-only", "origin", self.branch, check=False)
        if code != 0:
            logger.warning("hub checkout %s: no fast-forward from the hub, keeping local state: %s", self.root, out)

    async def push_head(self) -> None:
        """Publish this checkout's HEAD as the hub branch — a fast-forward only, so a
        re-share never rewrites what recipients already cloned."""
        await self.git("push", "-q", self.clone_url, f"HEAD:refs/heads/{self.branch}")
