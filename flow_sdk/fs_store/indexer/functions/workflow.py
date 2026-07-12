"""Walker(s) + extractor + id mint for WORKFLOW records.

Walkers:
  workflow_fn
      Folder-anchored: emits WORKFLOW for every ``*.md`` in
      ``<root>/.claude/workflows/``. Register on USER_HOME_FOLDER,
      REAL_PROJECT_CWD, CWD_ROOT; scope inherits via FSRef.

  workflow_frontmatter_fn
      Per-FOLDER emitter: receives FOLDER refs from the project walker
      and emits WORKFLOW for each direct ``*.md`` child whose YAML
      frontmatter declares ``type: workflow``. Lets workflow assets live
      in-place anywhere in the project tree, not just under
      ``.claude/workflows/``. Register on FOLDER.

Replaces the deleted ``WorkflowRecord`` subclass. Registration at module
bottom. ``default_body`` stub for new "+ New Workflow" creation is dropped —
new files are created empty and self-heal on first indexer pass when the
extractor mints+writes a frontmatter id.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer._frontmatter import (
    adopt_or_mint_id,
)
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


def workflow_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        workflows = Path(node.path) / ".claude" / "workflows"
        if not workflows.is_dir():
            continue
        for md in sorted(workflows.glob("*.md")):
            key = str(md.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(
                FSRef(md, record_type=RecordType.WORKFLOW, parent=node)
            )
    return out

_FM_PEEK_BYTES = 4 * 1024

def workflow_frontmatter_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    """Emit WORKFLOW for ``*.md`` files (direct children of each FOLDER)
    whose YAML frontmatter declares ``type: workflow``.

    Performance guards:
      - Only open files whose first 3 bytes are ``---`` (frontmatter prefix).
      - Read only the first ``_FM_PEEK_BYTES`` for parsing.

    A file with ``type: workflow`` frontmatter will additionally be picked
    up as MARKDOWN by ``markdown_in_folder_fn``; the two records have
    distinct ids and types, which is intentional during this additive
    rollout.
    """
    from flow_sdk.fs_store.indexer._frontmatter import _extract_frontmatter, _yaml_load

    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        if node.record_type != RecordType.FOLDER:
            continue
        folder_path = Path(node.path)
        try:
            entries = sorted(folder_path.glob("*.md"))
        except OSError:
            continue
        for md in entries:
            try:
                if not md.is_file():
                    continue
            except OSError:
                continue
            try:
                with md.open("rb") as fh:
                    head_bytes = fh.read(_FM_PEEK_BYTES)
            except OSError:
                continue
            if not head_bytes.startswith(b"---"):
                continue
            head = head_bytes.decode("utf-8", errors="replace")
            fm_text = _extract_frontmatter(head)
            if not fm_text:
                continue
            try:
                fields = _yaml_load(fm_text) or {}
            except Exception:
                continue
            if str(fields.get("type", "")).strip().lower() != "workflow":
                continue
            key = str(md.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(FSRef(md, record_type=RecordType.WORKFLOW, parent=node))
    return out

def workflow_id(ref: FSRef) -> str:
    """Cheap id (no write): adopted frontmatter capsule id; else stable derived key."""
    return adopt_or_mint_id(ref._path, write_back=False)

def workflow_gen_id(ref: FSRef) -> str:
    """Adopt the frontmatter capsule id, else mint a fresh v4 and write it back.

    The miss path now mints a random **v4** (not uuid5(path)) so a shared/copied
    workflow carries a portable id in its capsule. uuid5(path) survives only as
    the read-only-file fallback (inside ``adopt_or_mint_id``).
    """
    return adopt_or_mint_id(ref._path, write_back=True)

def extract_workflow(ref: FSRef) -> list[FSRecord]:
    """Parse a workflow .md into a Record. Replaces ``WorkflowRecord._from_fsref_sync``."""
    path = ref._path
    rec_id = workflow_id(ref)
    content = ""
    try:
        content = path.read_text(encoding="utf-8")
    except OSError:
        pass
    rec = FSRecord(
        type=RecordType.WORKFLOW,
        id=rec_id,
        name=path.stem,
        content=content,
    )
    rec.source_file = str(path)
    object.__setattr__(rec, "_asset_ref", FSRef(path))
    return [rec]
