"""Extractor + helpers for TASK records.

A task is a FOLDER asset (like ``skill``): ``agentic-assets/task/<name>/`` holds
``task.md`` (markdown + YAML frontmatter carrying the task fields) plus an inner
``spec.md`` (the plan/issue content — a PLAIN file, NOT its own entity; fenced
from the markdown walker by the ``agentic-assets`` ancestor check in
``markdown._typed_record_dirs``).

Legacy ``tasks/<title>/header.json`` (or ``manifest.json``) folders are still
tolerated for the migration window — extraction and the TypeInfo reader use the
JSON manifest when no ``task.md`` is present, preserving the exact id formula so
DB rows keyed by that value stay valid. The next entity save materializes
``task.md`` (Task ``owns_main_ref``), self-healing legacy folders.
"""

from __future__ import annotations

import uuid
from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.api.api_types.identifier import is_valid_entity_id, mint_uuid
from flow_sdk.fs_store.indexer._frontmatter import (
    _extract_frontmatter,
    _yaml_load,
)
from flow_sdk.fs_store.indexer.functions.skill import read_frontmatter_id_from_yaml
from flow_sdk.fs_store.record_types import RecordType

# Canonical Task fields that round-trip through ``task.md`` frontmatter, besides
# ``id``/``title``/``status`` (handled explicitly on both read and write). This
# is the SINGLE source of truth shared by the reader (``extract_task``) and the
# writer (``_task_default_body`` in task_type_info) — two hand-synced lists
# silently drift. It doubles as the SHARE whitelist: because sharing copies the
# folder verbatim, sender-local keys (``my_process_id``/``project_root``/
# ``project_id``/``project_name``) are deliberately absent, so a received task is
# runnable and maps its own local project.

# ---------------------------------------------------------------------------
# Domain enums live on the ENTITY — ``flow_sdk.builtin.task`` declares
# ``TaskStatus`` / ``TaskType`` / ``TaskKind``. This module used to carry a second
# copy of all three (unused here, and free to drift from the ones the entity
# actually validates against); import them from there if this module ever needs
# one. One type registry, one enum per typed value.
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# task.md frontmatter helpers
# ---------------------------------------------------------------------------


def _parse_frontmatter_fields(text: str) -> dict:
    """Parse a markdown doc's YAML frontmatter into a dict (empty if none)."""
    fm = _extract_frontmatter(text)
    fields = (_yaml_load(fm) or {}) if fm else {}
    return fields if isinstance(fields, dict) else {}


def _read_task_md_fields(task_md: Path) -> dict:
    """Read ``task.md`` and return its parsed frontmatter fields."""
    try:
        return _parse_frontmatter_fields(task_md.read_text(encoding="utf-8"))
    except OSError:
        return {}


def _mint_task_id(key: str) -> str:
    """Adopt ``key`` when it's a valid entity id, else derive a stable v5."""
    return key if is_valid_entity_id(key) else mint_uuid(f"{RecordType.TASK}:{key}", namespace=uuid.NAMESPACE_DNS)


def _task_id_from_fields(fields: dict, task_dir: Path) -> str:
    """The validated ``task.md`` frontmatter id, else the folder-name-derived v5
    (transitional)."""
    fm_id = read_frontmatter_id_from_yaml(fields)
    if fm_id and is_valid_entity_id(fm_id):
        return fm_id
    return _mint_task_id(task_dir.name)




# ---------------------------------------------------------------------------
# Content hash — mtime across inner files (folder mtime misses child edits)
# ---------------------------------------------------------------------------


def task_asset_hash(ref: FSRef) -> float:
    base = ref._path if ref._path.is_dir() else ref._path.parent
    ts = 0.0
    for name in ("task.md", "spec.md"):
        try:
            ts = max(ts, (base / name).stat().st_mtime)
        except OSError:
            pass
    return ts


# ---------------------------------------------------------------------------
# Extractor
# ---------------------------------------------------------------------------


def derive_task(data: dict, root: Path, header_raw: dict) -> None:
    """The title falls back to the folder; the name is the title."""
    data["title"] = data.get("title") or root.name
    data["name"] = data["title"]
