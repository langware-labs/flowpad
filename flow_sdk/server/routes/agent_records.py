"""Agent-driven schema + record routes.

Companion to ``routes/navigate.py``. Lets a local agent (invoked via
``flow schema ...`` and ``flow record ...``) discover the type registry
and persist new on-disk records via the canonical FSIndexer pipeline.

Error contract (CLI mirrors it exactly):

    200 ok                  — JSON success body
    400 INVALID_ARG         — bad path / unknown type / parse error
    404 NOT_FOUND           — type or path doesn't exist
    500 INDEX_FAILED        — indexer raised
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter()


def _error(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"ok": False, "error_code": code, "error": message},
    )


# Per-type creation hints. Tells the agent where on disk a new record of
# this type lives and what the manifest looks like — the indexer functions
# expect a fixed layout, and codifying that here is much faster than asking
# the agent to discover it from source. Add an entry when a new type
# becomes user-creatable.
_CREATION_HINTS: dict[str, dict] = {
    "task": {
        "location": "<project_cwd>/tasks/<safe-title>/manifest.json",
        "manifest_fields": {
            "task_id": "uuid v4 (you generate it; this becomes the entity id)",
            "name": "human-readable title",
            "status": "to_do | in_progress | done (default: to_do)",
            "task_type": "Task | analysis | skill_creation (default: Task)",
            "description": "free-text description (optional)",
            "objective": "free-text objective (optional)",
        },
        "example": {
            "task_id": "11111111-2222-3333-4444-555555555555",
            "name": "Write release notes",
            "status": "to_do",
            "task_type": "Task",
            "description": "Draft 0.2.9 release notes from the merged PRs.",
        },
        "after_index": "Resulting TypeId is `task-<task_id>` — pass it to `flow navigate entity` to open.",
    },
    "markdown_index": {
        "location": "<source_dir>/index.md",
        "manifest_fields": {
            "type": "markdown_index (literal)",
            "title": "human-readable folder name",
            "inputs_hash": "sha256 of (template_version + prompt_version + sorted source file hashes + sorted child index.md hashes) — set by rebuild agent",
            "template_version": "int (default 1)",
            "prompt_version": "int (default 1)",
            "parent_ref": "TypeId of the parent markdown_index entity (one folder up), or empty for root",
            "file_count": "int — direct source files in this folder (excluding index.md itself)",
            "subfolder_count": "int — child folders that also have an index.md",
            "latest_process_ref": "TypeId of the most recent AgenticProcess that rebuilt this index",
        },
        "example": {
            "type": "markdown_index",
            "title": "auth",
            "inputs_hash": "",
            "template_version": 1,
            "prompt_version": 1,
            "parent_ref": "",
            "file_count": 0,
            "subfolder_count": 0,
            "latest_process_ref": "",
        },
        "after_index": "Resulting TypeId is `markdown_index-<uuid>`. Trigger a rebuild via the LLM Indexers panel or by spawning an AgenticProcess with context_data.kind='markdown_index_rebuild' targeted at this TypeId.",
    },
}


# ─────────────────────────────────────────────────────────────────────────────
# /api/v1/agent/schema — list types + per-type info
# ─────────────────────────────────────────────────────────────────────────────


@router.get("/api/v1/agent/schema")
async def list_schema():
    """Return every registered type with its TypeInfo metadata.

    Output shape:
        {
          ok: true,
          types: [
            { type_name, uid_field, index_fields, defaults, creatable,
              browseable, indexed_by_default, icon, parent_type, locations,
              schema_hash, has_record_cls, has_entity_cls }
          ]
        }
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    types = []
    for name in sorted(SchemaRegistry.get_all_types()):
        info = SchemaRegistry.get(name)
        if info is None:
            continue
        d = info.to_dict()
        d["has_record_cls"] = info.record_cls is not None
        d["has_entity_cls"] = info.entity_cls is not None
        types.append(d)
    return {"ok": True, "types": types}


@router.get("/api/v1/agent/schema/{type_name}")
async def get_schema_info(type_name: str):
    """Return TypeInfo + creation hint for a single type.

    The creation hint comes from a per-type table in this module and tells
    the agent where on disk to materialize a new record before indexing.
    Falls back to a generic note when the type has no specific recipe.
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    info = SchemaRegistry.get(type_name)
    if info is None:
        return _error(404, "NOT_FOUND", f"Unknown type: {type_name}")

    payload = info.to_dict()
    payload["has_record_cls"] = info.record_cls is not None
    payload["has_entity_cls"] = info.entity_cls is not None

    # Pull the pydantic JSON schema when the record class exposes one
    # (most Record subclasses are pydantic models). Optional — absence
    # is fine, the creation hint already tells the agent enough.
    if info.record_cls is not None:
        try:
            payload["json_schema"] = info.record_cls.model_json_schema()
        except Exception:  # noqa: BLE001
            pass

    payload["creation"] = _CREATION_HINTS.get(
        type_name,
        {
            "location": "(no built-in recipe — ask the user where to put the file or read the indexer source)",
            "manifest_fields": {},
        },
    )
    return {"ok": True, "type": payload}


# ─────────────────────────────────────────────────────────────────────────────
# /api/v1/agent/record/index — run the indexer on a path
# ─────────────────────────────────────────────────────────────────────────────


class IndexRecordRequest(BaseModel):
    """Body for POST /api/v1/agent/record/index.

    ``path`` is an absolute filesystem path to a file or directory the agent
    has just written to disk. ``types`` is an optional restriction that
    speeds up indexing by only parsing the named types — pass it whenever
    you know what you wrote (e.g. ``["task"]`` after writing a manifest).
    """

    path: str
    types: Optional[list[str]] = None


@router.post("/api/v1/agent/record/index")
async def index_record(req: IndexRecordRequest):
    """Run the canonical FSIndexer over the user's known roots.

    The agent supplies ``path`` purely as a sanity check + for logging —
    we still walk the shared indexer's full root set, then return the
    counts. Filtering to ``types`` keeps parsing+upsert work proportional
    to what the agent actually created.
    """
    p = Path(req.path).expanduser()
    if not p.exists():
        return _error(404, "NOT_FOUND", f"Path does not exist: {p}")

    from flow_sdk.fs_records.all_projects import get_all_scope_filter  # noqa: PLC0415
    from flow_sdk.fs_store.fs_ref import FSRef  # noqa: PLC0415
    from flow_sdk.fs_store.indexer import IndexerOptions, get_shared_indexer  # noqa: PLC0415
    from flow_sdk.fs_store.indexer.roots import default_roots  # noqa: PLC0415
    from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415

    record_types: list[RecordType] | None = None
    if req.types:
        record_types = []
        for t in req.types:
            try:
                record_types.append(RecordType(t))
            except ValueError:
                return _error(400, "INVALID_ARG", f"Unknown record type: {t}")

    # default_roots() no longer auto-expands USER_HOME → REAL_PROJECT_CWD —
    # we removed the silent ``real_project_cwd_fn`` fanout. To preserve the
    # docstring's "walk the user's known roots" semantic for this endpoint
    # (an agent doesn't know which project cwd it's running inside), we
    # explicitly enumerate every known project via get_all_scope_filter and
    # union them with default_roots so user/system/cwd records still index.
    sf = await get_all_scope_filter(create_missing=True)
    project_roots: tuple[FSRef, ...] = tuple()
    if sf.projects:
        from flow_sdk.builtin.project import Project  # noqa: PLC0415
        from flow_sdk.db.drivers.query import QueryFilter  # noqa: PLC0415
        from pathlib import Path as _Path  # noqa: PLC0415
        per_project: list[FSRef] = []
        for pid in sf.projects:
            proj = await Project.get_one(QueryFilter.parse({"id": pid}))
            if proj is None:
                continue
            mount = getattr(proj, "fs_storage_mount_path", None)
            if not mount:
                continue
            mount_path = _Path(str(mount))
            if not mount_path.is_dir():
                continue
            per_project.append(FSRef(
                mount_path,
                record_type=RecordType.REAL_PROJECT_CWD,
                scope="project",
                project_id=pid,
            ))
        project_roots = tuple(per_project)
    all_roots = tuple(default_roots()) + project_roots

    try:
        result = await get_shared_indexer().index(
            IndexerOptions(verbose=False, types=record_types, roots=all_roots),
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("agent record/index failed for path=%s", p)
        return _error(500, "INDEX_FAILED", f"Indexer raised: {e}")

    per_type = {
        str(t): {"indexed": r.indexed, "errors": r.errors, "skipped": r.skipped}
        for t, r in result.per_type.items()
    }
    return {
        "ok": True,
        "path": str(p),
        "total_indexed": result.total_indexed,
        "total_errors": result.total_errors,
        "duration_ms": result.duration_ms,
        "per_type": per_type,
    }
