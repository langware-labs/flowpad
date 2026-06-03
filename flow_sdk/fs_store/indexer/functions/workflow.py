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

import uuid
from pathlib import Path

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType

from flow_sdk.fs_store.indexer._frontmatter import (
    _extract_body,
    _extract_frontmatter,
    _render_frontmatter,
    _yaml_load,
)

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

def _workflow_id_from_path(path: Path) -> str:
    from flow_sdk.fs_store.identifier import mint_uuid  # noqa: PLC0415
    return mint_uuid(str(path.resolve()))

def _read_workflow_asset_id(path: Path) -> str | None:
    """Return ``id`` (or legacy ``asset_id``) from frontmatter, or None."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    fm = _extract_frontmatter(text)
    if not fm:
        return None
    fields = _yaml_load(fm) or {}
    from flow_sdk.fs_store.identifier import adopt_entity_id  # noqa: PLC0415
    raw = fields.get("id") or fields.get("asset_id")
    return adopt_entity_id(raw)  # validate-on-adopt (v4/v5) → else caller derives uuid5(path)

def workflow_id(ref: FSRef) -> str:
    """Cheap id: prefer frontmatter ``id``; else uuid5(path)."""
    existing = _read_workflow_asset_id(ref._path)
    return existing if existing else _workflow_id_from_path(ref._path)

def workflow_gen_id(ref: FSRef) -> str:
    """Mint+write a stable id into the frontmatter (idempotent).

    Same shape as the deleted ``WorkflowRecord.genId``. Preserves any existing
    derived id so DB rows keyed on uuid5(path) stay valid.
    """
    existing = _read_workflow_asset_id(ref._path)
    if existing:
        return existing
    new_id = _workflow_id_from_path(ref._path)
    try:
        text = ref._path.read_text(encoding="utf-8")
    except OSError:
        return new_id
    fm = _extract_frontmatter(text)
    body = _extract_body(text)
    fields: dict = {}
    if fm:
        parsed = _yaml_load(fm)
        if isinstance(parsed, dict):
            fields.update(parsed)
    merged = {"id": new_id, **{k: v for k, v in fields.items() if k not in ("id", "asset_id")}}
    try:
        ref._path.write_text(
            _render_frontmatter(merged) + "\n\n" + body + ("\n" if body and not body.endswith("\n") else ""),
            encoding="utf-8",
        )
    except OSError:
        pass
    return new_id

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
