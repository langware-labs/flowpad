"""Walker + extractor + id mint + default body for DYNAMIC_WORKFLOW records.

A **dynamic workflow** is an authored, creatable asset (like an agent or a
skill): a JavaScript orchestration script in the Workflow-tool format
(``export const meta = { name, description, phases }`` + ``agent()`` /
``parallel()`` / ``pipeline()`` body). It is the *definition* a user writes and
then runs; each execution produces a separate WORKFLOW_RUN (the run journal /
transcript), the way an Agent definition produces AgenticProcess runs.

On disk it lives beside the AMD ``.md`` workflows under
``<root>/.claude/workflows/`` and is distinguished purely by extension:
``*.md`` → WORKFLOW (prose AMD), ``*.js`` → DYNAMIC_WORKFLOW (dynamic script).

The script has no YAML frontmatter to carry an id, so the entity id is a stable
v5 minted from the file path (validate-on-adopt is satisfied — the id is born
in the minter, never adopted from the file).
"""

from __future__ import annotations

import re
import uuid
from pathlib import Path

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identifier import mint_uuid
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType

_META_PEEK_BYTES = 8 * 1024


def _meta_field(head: str, key: str) -> str:
    """Value of ``<key>: '…'`` (single- or double-quoted) inside the
    ``export const meta`` literal head; empty string when absent. ``re`` caches
    the compiled pattern, so the two per-file lookups don't re-compile."""
    m = re.search(rf"""\b{re.escape(key)}\s*:\s*(['"])(.*?)\1""", head)
    return m.group(2) if m else ""

# ── Walker ───────────────────────────────────────────────────────────────────

def dynamic_workflows_fn(nodes: list[FSRef], opts: IndexerOptions) -> list[FSRef]:
    """Emit DYNAMIC_WORKFLOW for every ``*.js`` in ``<root>/.claude/workflows/``.
    Mirrors ``workflow_fn`` (the ``*.md`` AMD sibling). Register on
    USER_HOME_FOLDER / REAL_PROJECT_CWD / CWD_ROOT; scope inherits via FSRef."""
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        workflows = Path(node.path) / ".claude" / "workflows"
        if not workflows.is_dir():
            continue
        for js in sorted(workflows.glob("*.js")):
            key = str(js.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(FSRef(js, record_type=RecordType.DYNAMIC_WORKFLOW, parent=node))
    return out

# ── Id ───────────────────────────────────────────────────────────────────────

def _id_for_path(path: Path) -> str:
    """Stable v5 id from the resolved file path (the script carries no frontmatter id)."""
    return mint_uuid(f"{RecordType.DYNAMIC_WORKFLOW}:{path.resolve()}", namespace=uuid.NAMESPACE_URL)

def dynamic_workflow_id(ref: FSRef) -> str:
    """gen_uuid_fn — stable v5 id for the walked .js script."""
    return _id_for_path(ref._path)

# ── Extractor ────────────────────────────────────────────────────────────────

def _read_meta(path: Path) -> tuple[str, str]:
    """(name, description) parsed from the ``export const meta`` literal head."""
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            head = fh.read(_META_PEEK_BYTES)
    except OSError:
        return "", ""
    return _meta_field(head, "name"), _meta_field(head, "description")

def extract_dynamic_workflow(ref: FSRef) -> list[FSRecord]:
    return [extract_dynamic_workflow_from_path(ref._path)]

def extract_dynamic_workflow_from_path(path: str | Path) -> FSRecord:
    path = Path(path)
    name, description = _read_meta(path)
    rec = FSRecord(
        type=RecordType.DYNAMIC_WORKFLOW,
        id=_id_for_path(path),
        name=name or path.stem,
        description=description,
        source_file=str(path),
        path=str(path),
    )
    object.__setattr__(rec, "_asset_ref", FSRef(path))
    return rec

# ── Default body (creatable: starter script on "+ New") ───────────────────────

def dynamic_workflow_default_body(entity) -> str:
    """Starter dynamic-workflow script materialized at asset_ref on create."""
    name = (getattr(entity, "name", None) or "untitled-workflow").strip()
    desc = (getattr(entity, "description", None) or "What this workflow does").strip()
    return (
        "export const meta = {\n"
        f"  name: {name!r},\n"
        f"  description: {desc!r},\n"
        "  phases: [{ title: 'Main', detail: 'one agent' }],\n"
        "}\n\n"
        "phase('Main')\n"
        "const result = await agent('Describe the task for this agent.')\n"
        "return { result }\n"
    )
