"""Share one file-backed asset to the cloud and hand back a reviewer's link.

The verb behind ``flow record share``. It composes machinery that already
exists — the display-target resolver, the git preflight, the scoped commit, the
asset publisher, the hub URL builder — and adds the thing none of them own:
an *order*, and a refusal at every step that can be refused before anything is
mutated.

Two properties the gate order exists to guarantee:

* **Nothing is mutated until every refusal is behind us.** A user who is told
  "your project isn't linked to the cloud" must find their working tree exactly
  as they left it — not with a commit already pushed on their branch.
* **We commit, then publish.** ``publish_git_asset`` rejects ``BRANCH_AHEAD``
  when local HEAD is ahead of origin and the extra commit is not its own
  trailer-marked retry, so committing without pushing is a guaranteed failure
  one step later. Because we push first, the publisher's own internal commit
  finds no delta and no-ops — which is what puts the doc and the capsule in ONE
  commit authored by the user's real git identity, rather than a hand commit
  followed by a robot one.

Scoped throughout: only the paths the caller named are ever staged. In a shared
checkout a repo-wide ``git add`` would sweep a colleague's half-finished work
into a commit a breadcrumb tool authored.
"""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)


class ShareBlocked(Exception):
    """A gate refused. ``code`` is the stable vocabulary the CLI maps to exits.

    A plain Exception, not a dataclass: a dataclass never calls
    ``Exception.__init__``, so ``str(exc)`` comes back empty and the generated
    ``__eq__`` makes it unhashable — both surprising in a traceback.
    """

    def __init__(self, code: str, message: str, remediation: list[str] | None = None, data: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.remediation = remediation or []
        self.data = data or {}


@dataclass
class ShareOutcome:
    target: dict
    project: dict
    commit: dict
    publish: dict
    url: Optional[str]
    warnings: list[str] = field(default_factory=list)

    def payload(self) -> dict:
        return {
            "typeid": self.target.get("typeid"),
            "type": self.target.get("type"),
            "name": self.target.get("name"),
            "path": self.target.get("path"),
            "project": self.project,
            "commit": self.commit,
            "publish": self.publish,
            "url": self.url,
            "warnings": self.warnings,
        }


#: Preflight code → what the user should actually do about it. The backend's own
#: `reason` says what is wrong; these say what to type.
_PREFLIGHT_REMEDIATION = {
    "not-in-repo": "Run `git init`, add a GitHub `origin`, and push once.",
    "missing-remote": "`git remote add origin https://github.com/<owner>/<repo>.git` then `git push -u origin <branch>`.",
    "unsupported-origin": "Cloud sharing supports https GitHub origins only. Re-point `origin` at one.",
    "detached-head": "`git checkout <branch>` — cloud sharing pins a branch name, and a detached HEAD has none.",
    "no-commit": "`git add -A && git commit -m \"initial\" && git push -u origin <branch>`.",
    "dirty": (
        "Cloud sharing pins the exact commit reviewers clone, so the whole tree must be clean. "
        "Your breadcrumb files were NOT committed either — nothing was mutated. Commit or stash the rest."
    ),
    "unpushed": "`git push` — reviewers clone from GitHub, so local-only commits are invisible to them.",
    "status-failure": "Check the repository is healthy (`git status` by hand) and re-run.",
}


async def share_asset_to_hub(
    *,
    typeid: Optional[str] = None,
    path: Optional[str] = None,
    with_paths: Optional[list[str]] = None,
    message: Optional[str] = None,
    link_project: bool = False,
    dry_run: bool = False,
    no_commit: bool = False,
    actor: Any = None,
) -> ShareOutcome:
    """Run the gate sequence. Raises :class:`ShareBlocked` for anything a user can fix."""
    from flow_sdk.api.api_types.type_id import TypeId
    from flow_sdk.assets._publish_service import owning_project
    from flow_sdk.core.display_target import (
        DisplayTargetKind,
        DisplayTargetNotFound,
        InvalidDisplayTarget,
        hub_asset_url,
        resolve_display_target,
    )
    from flow_sdk.core.entity.entity_model import Entity
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    # ── G0: resolve the address. `discover=False` — a share must not index. ──
    try:
        target = await resolve_display_target(typeid=typeid, path=path)
    except InvalidDisplayTarget as e:
        raise ShareBlocked(code="INVALID_ARG", message=str(e)) from e
    except DisplayTargetNotFound as e:
        raise ShareBlocked(code="NOT_FOUND", message=str(e)) from e

    if target.get("kind") == DisplayTargetKind.VFS:
        raise ShareBlocked(
            code="NOT_INDEXED",
            message=f"{target.get('path')} is not an indexed asset.",
            remediation=[f"flow record index {target.get('path')}"],
        )

    # ── G1: is this type even publishable through git? ──
    type_name = str(target.get("type") or "")
    info = SchemaRegistry.get(type_name)
    if info is None or not info.git_publishable:
        raise ShareBlocked(
            code="NOT_PUBLISHABLE",
            message=f"'{type_name}' is not a git-publishable asset type, so it has no cloud link.",
        )

    entity = await Entity.get_by_typeid(TypeId(str(target.get("typeid"))))
    if entity is None or not getattr(entity, "asset_ref", None):
        raise ShareBlocked(code="NOT_PUBLISHABLE", message="This asset has no file backing it.")

    # ── G2: which project owns it? ──
    project = await owning_project(entity)
    if project is None:
        raise ShareBlocked(
            code="NO_PROJECT",
            message="This asset has no owning Project, so there is nowhere in the cloud to put it.",
        )
    mount = getattr(project, "fs_storage_mount_path", None)
    if not mount:
        raise ShareBlocked(code="NO_PROJECT", message=f"Project '{project.name}' has no local folder.")

    # ── G3: is there a cloud at all? ──
    hub_origin = _hub_app_origin()
    if not hub_origin:
        raise ShareBlocked(
            code="LOCAL_MODE",
            message="This instance is in Local mode — there is no cloud to share to, and no link to hand out.",
        )

    project_info = {"id": str(project.id), "name": project.name, "linked": getattr(project, "remote", False) is True}
    url = hub_asset_url(target, hub_origin=hub_origin, project_id=str(project.id))

    # ── G4: every path must live inside the repo. ──
    # Ahead of the link gate on purpose: this is pure path arithmetic, and
    # linking is a network mutation visible to every project member. Refusing a
    # typo'd `--with` AFTER publishing a repo declaration would make the
    # "nothing was mutated" promise below a lie.
    repo_root, rel_paths = _repo_relative_paths(entity, mount, with_paths or [])

    # ── G5: is the project linked? THE LAST GATE BEFORE ANY MUTATION. ──
    linked_now = False
    if not project_info["linked"]:
        if not link_project:
            raise ShareBlocked(
                code="PROJECT_NOT_LINKED",
                message=(
                    f"The project '{project.name}' isn't linked to the cloud, so this asset has "
                    "nowhere for a reviewer to read it from. Nothing was committed or pushed."
                ),
                remediation=[
                    f"Open Project Home for '{project.name}' and press \"Link to cloud\"",
                    "or re-run this command with --link-project",
                ],
                data={"project": project_info, "docs_path": "docs/collab/cloud-sharing.md"},
            )
        if dry_run:
            # Report what WOULD happen without claiming it happened.
            return ShareOutcome(
                target=target,
                project={**project_info, "would_link": True},
                commit={"paths": rel_paths, "state": "dry-run"},
                publish={"state": "dry-run"},
                url=url,
            )
        await _link_project(project, actor)
        linked_now = True
        project_info = {**project_info, "linked": True}
    project_info["linked_now"] = linked_now

    if dry_run:
        return ShareOutcome(
            target=target,
            project=project_info,
            commit={"paths": rel_paths, "state": "dry-run"},
            publish={"state": "dry-run"},
            url=url,
        )

    warnings: list[str] = []

    # ── G6: mutation 1 — commit and push exactly our paths. ──
    commit_info: dict = {"paths": rel_paths, "state": "skipped", "pushed": False}
    if not no_commit:
        commit_info = await _commit_paths(repo_root, rel_paths, message, entity, warnings)

    # ── G7: mutation 2 — register the asset with the hub. ──
    publish_info = await _publish(entity, actor, warnings)

    # ── G8: the deliverable. ──
    warnings.append("Reviewers need to be members of this project — add them in Members.")
    return ShareOutcome(
        target=target, project=project_info, commit=commit_info, publish=publish_info, url=url, warnings=warnings
    )


def _hub_app_origin() -> Optional[str]:
    """The hub's BROWSER origin, or None in Local mode.

    Two different Python answers to "where is the hub" and they are not
    interchangeable: ``hub_base_url()`` is the Local-mode gate (it returns None
    when privacy mode is on, which is the chokepoint that stops outbound
    calls), while ``ApiConfig.app_base_url`` is the browser origin a human can
    click. Use the first to decide, the second as the value — do not "unify"
    them or Local mode starts emitting links.
    """
    from flow_sdk.cloud_client.client import ApiConfig
    from flow_sdk.cloud_client.transport.hub_http import hub_base_url

    if not hub_base_url():
        return None
    return ApiConfig.from_env().app_base_url


async def _link_project(project, actor) -> None:
    from flow_sdk.app.actions.project_publish import ProjectPublishBlocked, assert_project_publishable

    try:
        origin = await assert_project_publishable(project, actor)
    except ProjectPublishBlocked as blocked:
        # Codes pass through verbatim (upper-snake). Collapsing the ones without
        # a remediation hint to PROJECT_NOT_READY made `cloud_login_required`
        # and `github_not_connected` unreachable — so the CLI could never tell a
        # user which of the two they actually needed to fix.
        hint = _PREFLIGHT_REMEDIATION.get(blocked.code)
        raise ShareBlocked(
            code=blocked.code.upper().replace("-", "_"),
            message=blocked.message,
            remediation=[hint] if hint else [],
            data=blocked.data(),
        ) from blocked

    project.git_origin = origin
    await project.share()
    await project.save(actor)


def _repo_relative_paths(entity, mount: str, with_paths: list[str]) -> tuple[str, list[str]]:
    """(repo root, repo-relative posix paths) for the asset plus every ``--with``."""
    from flow_sdk.utils.git import find_project_root

    repo_root = find_project_root(mount)
    if not repo_root:
        raise ShareBlocked(
            code="NOT_IN_REPO",
            message=f"{mount} is not inside a Git repository, so there is nothing for the cloud to reference.",
            remediation=[_PREFLIGHT_REMEDIATION["not-in-repo"]],
        )

    root = Path(repo_root).resolve()
    rels: list[str] = []
    for raw in [str(entity.asset_ref), *with_paths]:
        candidate = Path(os.path.abspath(os.path.expanduser(str(raw))))
        try:
            rel = candidate.resolve().relative_to(root)
        except ValueError as exc:
            raise ShareBlocked(
                code="INVALID_ARG",
                message=f"{candidate} is outside the project's repository ({root}) — refusing to commit it.",
            ) from exc
        posix = rel.as_posix()
        if posix not in rels:
            rels.append(posix)
    return str(root), rels


async def _commit_paths(repo_root: str, rel_paths: list[str], message: Optional[str], entity, warnings: list[str]) -> dict:
    from flow_sdk.utils.git import git_add_commit_push

    dirty_others = await _other_dirty_files(repo_root, rel_paths)
    result = await git_add_commit_push(repo_root, rel_paths, message or _default_message(entity))
    if not result.ok:
        raise ShareBlocked(
            code="PUSH_FAILED" if result.committed else "COMMIT_FAILED",
            message=result.message,
            data={"committed": result.committed, "sha": result.sha},
        )
    if result.warning:
        warnings.append(result.warning)
    if dirty_others:
        warnings.append(
            f"{dirty_others} other file(s) in this repo are modified. They were not committed — "
            f"only {', '.join(rel_paths)} were."
        )
    return {
        "paths": rel_paths,
        "state": "committed" if result.committed else "nothing-to-commit",
        "sha": result.sha,
        "pushed": result.pushed,
        "branch": result.branch,
    }


def _default_message(entity) -> str:
    name = getattr(entity, "name", None) or getattr(entity, "title", None) or entity.get_type()
    return f"docs({entity.get_type()}): share {name}"


async def _other_dirty_files(repo_root: str, rel_paths: list[str]) -> int:
    """How many OTHER files are modified — reported, never committed.

    Tracked files only (`-uno`): untracked files were never candidates for our
    pathspec-scoped commit, and walking them is the expensive half of a status
    on a large tree. Off the event loop like every other git call here.
    """
    from flow_sdk.utils.git import _run_git  # noqa: PLC0415

    try:
        out = await asyncio.to_thread(_run_git, ["git", "status", "--porcelain", "-uno"], repo_root)
    except Exception:  # noqa: BLE001 — a status we cannot read is not a reason to refuse
        return 0
    ours = set(rel_paths)
    return sum(1 for line in out.stdout.splitlines() if (path := _porcelain_path(line)) and path not in ours)


def _porcelain_path(line: str) -> str:
    """The path a `git status --porcelain` line refers to.

    Takes the NEW name of a rename (`R  old -> new`) and unquotes the form git
    uses for paths with spaces or non-ASCII — without both, a file we just
    committed fails to match `ours` and gets counted as somebody else's work.
    """
    path = line[3:].strip()
    if " -> " in path:
        path = path.split(" -> ", 1)[1]
    return path.strip('"')


async def _publish(entity, actor, warnings: list[str]) -> dict:
    from flow_sdk.assets.git_publish import AssetPublishError, publish_git_asset

    try:
        result = await publish_git_asset(entity, actor)
    except AssetPublishError as e:
        raise ShareBlocked(code=str(e.code).upper(), message=str(e), data=dict(e.data or {})) from e
    payload = result.model_dump(mode="json") if hasattr(result, "model_dump") else dict(result or {})
    if payload.get("local_cache_warning"):
        warnings.append(str(payload["local_cache_warning"]))
    return payload
