"""Indexer functions: MARKDOWN discovery.

Two functions, split by *search strategy* (not by scope — scope inherits
via FSRef):

  markdown_flat_fn
      rglob <root>/.claude/docs/**/*.md
      Register on USER_HOME_FOLDER, SYSTEM_ROOT (flat dir scan only).

  markdown_with_docs_subdirs_fn
      rglob <root>/.claude/docs/**/*.md PLUS rglob every depth-3 'docs/'
      subdir under <root> (excluding _WALK_IGNORED).
      Register on REAL_PROJECT_CWD, CWD_ROOT.

Reproduces flow_sdk/fs_records/markdown_record.py:_doc_search_dirs
+ _find_docs_subdirs + _external_source_iter. FLOWPAD_DOC_DIRS env-var
support is deferred (empty on this machine; separate follow-up if needed).
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_records.markdown_record import _find_docs_subdirs
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


def _emit_md_rglob(
    root: Path, parent: FSRef, out: list[FSRef], seen: set[str],
) -> None:
    if not root.is_dir():
        return
    for md in sorted(root.rglob("*.md")):
        key = str(md.resolve())
        if key in seen:
            continue
        seen.add(key)
        out.append(FSRef(md, record_type=RecordType.MARKDOWN, parent=parent))


async def markdown_flat_fn(
    nodes: list[FSRef], opts: IndexerOptions,
) -> list[FSRef]:
    """<root>/.claude/docs/**/*.md — flat, no docs-subdir search."""
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        _emit_md_rglob(Path(node.path) / ".claude" / "docs", node, out, seen)
    return out


async def markdown_with_docs_subdirs_fn(
    nodes: list[FSRef], opts: IndexerOptions,
) -> list[FSRef]:
    """<root>/.claude/docs + every depth-3 'docs/' subdir under <root>."""
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        root = Path(node.path)
        _emit_md_rglob(root / ".claude" / "docs", node, out, seen)
        for docs_dir in _find_docs_subdirs(root):
            _emit_md_rglob(docs_dir, node, out, seen)
    return out
