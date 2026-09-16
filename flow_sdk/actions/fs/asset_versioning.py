"""Storage-action adapter for filesystem asset versioning."""
import asyncio
import logging
import os
from pathlib import Path

from flow_sdk.assets.document import DocumentPatch, read_document, update_document
from flow_sdk.assets.versioning import _asset_scope, _strip_version
from flow_sdk.utils.git import _run_git, find_project_root, git_commit_file

logger = logging.getLogger(__name__)


async def prepare_document_version(real_path: str):
    """Obtain Git evidence before the filesystem write critical section."""
    try:
        repo = await asyncio.to_thread(find_project_root, real_path)
        if not repo:
            return None
        text = await asyncio.to_thread(Path(real_path).read_text, encoding="utf-8")
        scope = _asset_scope(real_path, repo, text)
        if scope is None:
            return None
        pathspec, main_rel, main_abs = scope
        head = await asyncio.to_thread(_run_git, ["git", "show", f"HEAD:./{main_rel}"], repo)
        return (repo, pathspec, main_rel, main_abs, head.stdout if head.returncode == 0 else "")
    except (OSError, ValueError):
        logger.warning("[asset-version] version preparation skipped", exc_info=True)
        return None


async def finish_document_version(real_path: str, document, context) -> None:
    """Commit an already-versioned main document; support files bump their owner."""
    if context is None:
        return
    repo, pathspec, main_rel, main_abs, _base = context
    try:
        if Path(main_abs).resolve() != Path(real_path).resolve():
            await _bump_version_and_commit(real_path, document.raw_text)
        elif await _scope_changed_excluding_version(repo, pathspec, main_rel):
            name = document.fields.get("name") or Path(main_rel).stem
            version = document.fields.get("version", 1)
            await git_commit_file(repo, pathspec, f"Flowpad: {name} v{version}")
    except Exception:
        logger.warning("[asset-version] auto-commit skipped", exc_info=True)


def _real_path(storage, vfs_abs_path: str) -> str | None:
    """Resolve the real on-disk path for a local storage driver, else None."""
    resolver = getattr(storage, "_local_full_path", None)
    if not callable(resolver):
        return None
    try:
        return resolver(vfs_abs_path)
    except Exception:  # noqa: BLE001
        return None


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
        before = await asyncio.to_thread(read_document, main_abs)
    except OSError:
        return None
    fields = before.fields
    try:
        current = int(fields.get("version", 1))
    except (TypeError, ValueError):
        current = 1
    new_version = current + 1
    name = fields.get("name") or Path(main_rel).stem
    await asyncio.to_thread(update_document, Path(main_abs), DocumentPatch(set_fields={"version": new_version}),
                            expected_revision=before.revision)
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
