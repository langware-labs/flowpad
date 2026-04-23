"""Indexer functions: MARKDOWN discovery.

Two registrations:
  USER_HOME_FOLDER -> MARKDOWN  (user + flowpad_assistant + cwd docs + FLOWPAD_DOC_DIRS)
  REAL_PROJECT_CWD -> MARKDOWN  (per-project: docs subdirs via _find_docs_subdirs + .claude/docs)

Reproduces flow_sdk/fs_records/markdown_record.py:_doc_search_dirs
+ _find_docs_subdirs + _external_source_iter.

This is the expensive walker (~29 s of full-scan time in legacy). The depth-3
os.walk and prune list (`_WALK_IGNORED`) live inside the function body —
the IndexerFunc signature doesn't need a new primitive to express them.
"""

from __future__ import annotations

import os
from pathlib import Path

from flow_sdk.fs_records.markdown_record import _find_docs_subdirs  # reuse existing helper
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


def _emit_md_rglob(
    root: Path,
    parent: FSRef,
    out: list[FSRef],
    seen: set[str],
) -> None:
    if not root.is_dir():
        return
    for md in sorted(root.rglob("*.md")):
        key = str(md.resolve())
        if key in seen:
            continue
        seen.add(key)
        out.append(FSRef(md, record_type=RecordType.MARKDOWN, parent=parent))


async def markdown_user_fn(
    nodes: list[FSRef], opts: IndexerOptions,
) -> list[FSRef]:
    """USER_HOME_FOLDER -> MARKDOWN. User + system + cwd docs + env."""
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        _emit_md_rglob(Path(node.path) / ".claude" / "docs", node, out, seen)
        try:
            from flow_sdk.config import flowpad_assistant_project_root
            _emit_md_rglob(
                flowpad_assistant_project_root() / ".claude" / "docs",
                node, out, seen,
            )
        except Exception:
            pass
        cwd = Path(os.getcwd())
        _emit_md_rglob(cwd / ".claude" / "docs", node, out, seen)
        for docs_dir in _find_docs_subdirs(cwd):
            _emit_md_rglob(docs_dir, node, out, seen)
        for extra in os.environ.get("FLOWPAD_DOC_DIRS", "").split(":"):
            if extra.strip():
                _emit_md_rglob(Path(extra.strip()), node, out, seen)
    return out


async def markdown_project_fn(
    nodes: list[FSRef], opts: IndexerOptions,
) -> list[FSRef]:
    """REAL_PROJECT_CWD -> MARKDOWN. Per-project docs subdirs + .claude/docs."""
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        real = Path(node.path)
        for docs_dir in _find_docs_subdirs(real):
            _emit_md_rglob(docs_dir, node, out, seen)
        _emit_md_rglob(real / ".claude" / "docs", node, out, seen)
    return out
