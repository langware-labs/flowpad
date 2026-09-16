"""Pure filesystem version scope and document transformations.

Hooked from the ``fs`` ``write`` action — the client file-write seam — so a save
that actually changes an asset's content bumps the frontmatter ``version`` and
records a file-scoped git commit. Indexer/system writes go straight to disk
(never through the ``write`` action), so this path is not re-entered by indexing.

Local-first: only ``LocalStorageDriver`` resolves to a real on-disk path that git
can operate on; on remote/sandbox storage this is a no-op. Everything here is
best-effort — a failure must never break the underlying save.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from flow_sdk.assets.frontmatter import (
    _extract_frontmatter,
    merge_frontmatter,
)
from flow_sdk.assets.scope import _folder_backed_types, folder_asset_for

logger = logging.getLogger(__name__)


def _strip_version(text: str) -> str:
    """Asset text with the auto-managed ``version`` frontmatter field removed and
    frontmatter re-rendered canonically — the comparison key for "did the asset
    actually change?". Two saves differing only by the version bump (or by benign
    frontmatter formatting the YAML writer normalizes) collapse to the same key."""
    if _extract_frontmatter(text) is None:
        return text
    from flow_sdk.assets.document import read_document_bytes
    from flow_sdk.assets.frontmatter import _render_frontmatter

    document = read_document_bytes(text.encode("utf-8"))
    if document.metadata_error:
        return text
    fields = {key: value for key, value in document.fields.items() if key != "version"}
    return _render_frontmatter(fields) + "\n" + document.body


def version_document(text: str, base: str) -> str:
    """Bump a changed frontmatter document against caller-supplied prior bytes."""
    from flow_sdk.assets.document import read_document_bytes

    document = read_document_bytes(text.encode("utf-8"))
    if document.metadata_error or _extract_frontmatter(text) is None or _strip_version(text) == _strip_version(base):
        return text
    try:
        version = int(document.fields.get("version", 1)) + 1
    except (ValueError, TypeError):
        version = 2
    return merge_frontmatter(text, {"version": version})






def _versionable_folder_types() -> list:
    """``asset_scope``'s folder-backed types narrowed to those whose main file can
    CARRY the frontmatter ``version:`` this module writes — skill, task, whiteboard.
    The test is the type's ``identity_carrier``: ``Frontmatter`` already means
    "my id lives in this document's header", the gate the identity seam uses too.
    Which folders are assets is shape (there); which may be STAMPED is policy (here).
    """
    from flow_sdk.assets.identity_carrier import Frontmatter

    return [t for t in _folder_backed_types() if isinstance(t.identity_carrier, Frontmatter)]


def _versionable_main_files() -> set[str]:
    """Lower-cased main-file names this module may stamp, or ``set()`` if the
    registry is momentarily unavailable — an unresolvable type must never be
    stamped blind, so the empty set correctly refuses every folder asset."""
    try:
        return {t.shape.main.lower() for t in _versionable_folder_types()}
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
