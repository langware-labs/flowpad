"""Agent-driven schema routes.

Companion to ``routes/navigate.py``. Lets a local agent (invoked via
``flow schema ...``) discover the type registry and per-type creation
recipes. Record indexing lives elsewhere: ``flow record index`` drives the
canonical generic indexer at
``POST /api/v1/graph/compute_node/@local/fs-records/index`` directly, so
there is no agent-specific index endpoint to keep in sync.

Error contract (CLI mirrors it exactly):

    200 ok                  — JSON success body
    400 INVALID_ARG         — unknown type
    404 NOT_FOUND           — type doesn't exist
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

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


def _derive_creation_hint(info) -> dict | None:
    """Build a creation recipe straight from the type's registered schema.

    Generic for any ``creatable`` type whose primary asset is a single file
    (``main_layout == "file"``): the agent writes one markdown file with YAML
    frontmatter at ``<project_cwd>/<main_subdir>/<safe-title>.md`` and indexes
    it. Every coordinate — the subfolder, the uid field, the frontmatter
    fields — is sourced from ``TypeInfo`` so nothing is hardcoded per type and
    new file-layout types become agent-creatable for free. Folder-layout and
    otherwise-irregular types are left to the ``_CREATION_HINTS`` override
    table. Returns None when no generic recipe applies.
    """
    if not info.creatable or not info.main_subdir or info.main_layout != "file":
        return None
    uid = info.uid_field
    fields: dict[str, str] = {
        uid: "uuid v4 (you generate it; write it into the frontmatter `id:` — this becomes the entity id)",
    }
    for f in info.index_fields:
        fields[f] = f"see json_schema for `{f}`"
    example: dict = {uid: "11111111-2222-3333-4444-555555555555"}
    for f in info.index_fields:
        example[f] = "" if f != "tags" else []
    return {
        "location": f"<project_cwd>/{info.main_subdir}/<safe-title>.md",
        "format": "markdown file: YAML frontmatter (the fields below) followed by the document content as the markdown body",
        "manifest_fields": fields,
        "example": example,
        "after_index": f"Resulting TypeId is `{info.type_name}-<{uid}>` — pass it to `flow navigate entity` to open.",
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
    payload["has_entity_cls"] = info.entity_cls is not None

    if info.entity_cls is not None:
        try:
            payload["json_schema"] = info.entity_cls.model_json_schema()
        except Exception:  # noqa: BLE001
            pass

    # Override table first (irregular layouts: task's manifest.json, the
    # markdown_index computed fields), then a schema-derived recipe for any
    # plain file-layout type, then the "unsupported" fallback.
    payload["creation"] = (
        _CREATION_HINTS.get(type_name)
        or _derive_creation_hint(info)
        or {
            "location": "(no built-in recipe — ask the user where to put the file or read the indexer source)",
            "manifest_fields": {},
        }
    )
    return {"ok": True, "type": payload}
