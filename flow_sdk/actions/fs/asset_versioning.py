"""Auto-versioning of asset files on save (local instances).

Hooked from the ``fs`` ``write`` action — the client file-write seam — so a save
that actually changes an asset's content bumps the frontmatter ``version`` and
records a file-scoped git commit. Indexer/system writes go straight to disk
(never through the ``write`` action), so this path is not re-entered by indexing.

Local-first: only ``LocalStorageDriver`` resolves to a real on-disk path that git
can operate on; on remote/sandbox storage this is a no-op. Everything here is
best-effort — a failure must never break the underlying save.
"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path

from flow_sdk.actions.fs.asset_scope import _folder_backed_types, folder_asset_for
from flow_sdk.fs_store.fs_record import write_text_if_changed
from flow_sdk.fs_store.indexer._frontmatter import (
    _extract_frontmatter,
    _yaml_load,
    merge_frontmatter,
)
from flow_sdk.utils.git import _run_git, find_project_root, git_commit_file

logger = logging.getLogger(__name__)


def _real_path(storage, vfs_abs_path: str) -> str | None:
    """Resolve the real on-disk path for a local storage driver, else None."""
    resolver = getattr(storage, "_local_full_path", None)
    if not callable(resolver):
        return None
    try:
        return resolver(vfs_abs_path)
    except Exception:  # noqa: BLE001
        return None


def _strip_version(text: str) -> str:
    """Asset text with the auto-managed ``version`` frontmatter field removed and
    frontmatter re-rendered canonically — the comparison key for "did the asset
    actually change?". Two saves differing only by the version bump (or by benign
    frontmatter formatting the YAML writer normalizes) collapse to the same key."""
    if _extract_frontmatter(text) is None:
        return text
    return merge_frontmatter(text, {}, drop_keys=("version",))


def _porcelain_path(line: str) -> str:
    """The path out of a ``git status --porcelain`` line (2 status chars + space +
    path), taking the new name of an ``old -> new`` rename and unquoting."""
    path = line[3:].strip()
    if " -> " in path:
        path = path.split(" -> ", 1)[1]
    return path.strip().strip('"')


async def _scope_changed_excluding_version(
    repo_root: str, pathspec: str, main_rel: str
) -> bool:
    """True when the asset (one file, or a whole folder for folder-backed types)
    differs from HEAD by something OTHER than the main file's ``version`` field.

    A version-only delta on the main file is the phantom-revision storm (every
    save re-bumps ``version`` → a commit whose diff is just ``version: N→N+1``);
    that must not mint a revision. Any change to a non-main file in the asset
    folder, or a real body/field change to the main file, is a genuine change.
    """
    status = await asyncio.to_thread(
        _run_git, ["git", "status", "--porcelain", "--", pathspec], repo_root
    )
    changed = [_porcelain_path(ln) for ln in (status.stdout or "").splitlines() if ln.strip()]
    if not changed:
        return False
    if any(p != main_rel for p in changed):
        return True  # a non-main file in the asset folder changed → real change
    # Only the main file changed — genuine iff it differs from HEAD ignoring `version`.
    head = await asyncio.to_thread(
        _run_git, ["git", "show", f"HEAD:./{main_rel}"], repo_root
    )
    head_text = head.stdout if head.returncode == 0 else ""
    try:
        work_text = Path(repo_root, main_rel).read_text(encoding="utf-8")
    except OSError:
        return True
    return _strip_version(head_text) != _strip_version(work_text)


def _versionable_folder_types() -> list:
    """The folder-backed types from ``asset_scope`` whose main file can CARRY the
    frontmatter ``version:`` header THIS module writes — skill (SKILL.md), task
    (task.md), whiteboard (WHITE_BOARD.md).

    ``_folder_backed_types`` answers the shape question, and it is the same answer
    ``folder_asset_for`` resolved a moment earlier, so this filter can only ever
    narrow the set the caller actually got — the two cannot disagree about which
    folders are assets. Single-file types are not in it at all; they reach the
    frontmatter guard in ``_asset_scope`` instead.

    The narrowing test is the type's own ``identity_carrier``: a
    ``FrontmatterCarrier`` (these three, via ``FolderMdCarrier``) already declares
    "my id lives in this document's header", which is the same statement as "this
    file can hold one". It is the partition the identity seam itself uses — see
    the matching isinstance gate in ``SchemaRegistry.carrier_path_for`` — so a new
    markdown-bodied type is picked up automatically and a type that changes body
    format cannot drift out of sync with a filename check.

    This lives HERE and not in ``asset_scope`` on purpose. Which folders are
    assets is a fact about shape, shared with the git-ops endpoints; which files
    may be STAMPED is a versioning policy owned by this module. What versioning
    SHOULD mean for a JSON-bodied asset is a separate decision; until it is made
    they simply do not participate.
    """
    from flow_sdk.fs_store.identity_carrier import FrontmatterCarrier

    return [t for t in _folder_backed_types() if isinstance(t.identity_carrier, FrontmatterCarrier)]


def _versionable_main_files() -> set[str]:
    """Lower-cased main-file names this module may stamp, or ``set()`` if the
    registry is momentarily unavailable — an unresolvable type must never be
    stamped blind, so the empty set correctly refuses every folder asset."""
    try:
        return {t.main_file.lower() for t in _versionable_folder_types()}
    except Exception:  # noqa: BLE001
        logger.debug("versionable-type resolve: registry unavailable", exc_info=True)
        return set()


def _asset_scope(real_path: str, repo_root: str, content: str) -> tuple[str, str, str] | None:
    """Resolve the git scope of the asset the written ``real_path`` belongs to.

    Returns ``(commit_pathspec, main_rel, main_abs)`` — repo-root-relative except
    ``main_abs`` — or ``None`` when ``real_path`` is not (part of) an asset.

    * Folder-backed asset (skill): scope is the whole folder; the version lives in
      the inner main file (SKILL.md), so an internal-file edit still bumps the
      asset's version and records a folder-scoped revision. The main file must be
      able to CARRY that version — see ``_versionable_folder_types``.
    * Single-file / inner-file asset (agent, markdown, spec): scope is the file
      itself, which must carry frontmatter to be an asset.

    Both branches therefore ask the same question — "can the thing I am about to
    stamp hold a YAML header?" — and the two guards below are that one rule.
    """
    folder = folder_asset_for(real_path)
    if folder is not None:
        asset_folder, main_abs = folder
        if Path(main_abs).name.lower() not in _versionable_main_files():
            # A folder asset whose main file cannot hold a YAML header (mcp.json,
            # deck.json …). It is still a folder asset for git scoping — only the
            # STAMP is refused. Symmetric with the single-file guard below.
            return None
        return (
            os.path.relpath(asset_folder, repo_root),
            os.path.relpath(main_abs, repo_root),
            str(main_abs),
        )
    if _extract_frontmatter(content) is None:
        return None  # only assets (files carrying YAML frontmatter)
    rel = os.path.relpath(real_path, repo_root)
    return rel, rel, real_path


async def _bump_version_and_commit(real_path: str, content: str) -> dict | None:
    """Bump the asset's frontmatter ``version`` and record a scoped git commit iff
    the asset actually changed (ignoring the auto-managed version field). Returns
    ``{"hash", "version"}`` of the new revision, else ``None``.

    Asset-scoped, not file-scoped: a folder-backed asset (skill) commits its whole
    folder and bumps the inner main file's version, so edits to its internal files
    are versioned and diffable like any other change. Shared by the ``fs.write``
    autosave hook and the explicit UI-triggered commit so the rule lives in one
    place.
    """
    repo_root = find_project_root(real_path)
    if not repo_root:
        return None
    scope = _asset_scope(real_path, repo_root, content)
    if scope is None:
        return None
    pathspec, main_rel, main_abs = scope
    if not await _scope_changed_excluding_version(repo_root, pathspec, main_rel):
        return None  # no real change (identical to HEAD, or version/formatting only)
    try:
        main_text = Path(main_abs).read_text(encoding="utf-8")
    except OSError:
        return None
    fields = _yaml_load(_extract_frontmatter(main_text) or "") or {}
    try:
        current = int(fields.get("version", 1))
    except (TypeError, ValueError):
        current = 1
    new_version = current + 1
    name = fields.get("name") or Path(main_rel).stem
    write_text_if_changed(Path(main_abs), merge_frontmatter(main_text, {"version": new_version}))
    await git_commit_file(repo_root, pathspec, f"Flowpad: {name} v{new_version}")
    head = await asyncio.to_thread(
        _run_git, ["git", "log", "-1", "--format=%H", "--", pathspec], repo_root
    )
    return {"hash": (head.stdout or "").strip(), "version": new_version}


async def commit_asset_change(real_path: str) -> dict | None:
    """Bump + commit a single asset already edited on disk (the "commit" step of
    the improvement cycle). The autoversion hook fires on the ``fs.write`` action,
    but an agent (a skill-fixer worker) edits via its ``Edit`` tool — a raw disk
    write that bypasses that seam — so this reads the on-disk content and commits
    it explicitly. Returns ``{"hash", "version"}`` or ``None`` if nothing changed.
    """
    if not os.path.isfile(real_path):
        return None
    # Resolve symlinks (e.g. macOS /tmp → /private/tmp) so the path agrees with
    # find_project_root's realpath output — else relpath lands "outside repo".
    real_path = os.path.realpath(real_path)
    return await _bump_version_and_commit(real_path, Path(real_path).read_text(encoding="utf-8"))


async def autoversion_commit_local(storage, vfs_abs_path: str, content: str, *, real_path: str | None = None) -> None:
    """Bump frontmatter ``version`` and commit on save, for frontmatter-bearing
    files in a git repo on local storage. The bump is written directly to the real
    path (not back through the ``write`` action), so it never re-enters this hook.
    """
    try:
        if not isinstance(content, str):
            return
        real = real_path if real_path is not None else _real_path(storage, vfs_abs_path)
        if not real:
            return  # remote/sandbox storage — no local git tree
        await _bump_version_and_commit(real, content)
    except Exception as e:  # noqa: BLE001 — auto-versioning must never break a save
        logger.warning("[asset-version] auto-commit skipped (non-fatal): %s", e)
