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

import json
import uuid
from pathlib import Path
from typing import Any

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identifier import is_valid_entity_id, mint_uuid
from flow_sdk.fs_store.indexer._frontmatter import (
    _extract_body,
    _extract_frontmatter,
    _yaml_load,
)
from flow_sdk.fs_store.indexer.functions._folder_capsule import (
    read_folder_capsule_id,
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
TASK_FRONTMATTER_FIELDS = (
    "task_type",
    "kind",
    "parent_id",
    "assignee",
    "priority",
    "tags",
    "due_at",
    "start_date",
    "completed_at",
    "archived_at",
    "spec_type",
    "shared_by_id",
    "shared_process_id",
    "active_form",
    "analysis_json_path",
    "analysis_path",
    "artifacts",
    "git_origin",
    "classification_category",
    "classification_command",
    "classification_path",
    "classification_title",
    "command",
    "error_fingerprint",
    "folder_name",
    "output_dir",
    "process_id",
    "recipient_email",
    "result_uname",
    "sender_email",
    "sender_name",
    "session_id",
    "skill_name",
    "skill_path",
    "skill_scope",
    "task_type_label",
    "team_space_id",
    "worker_session_id",
)

# ---------------------------------------------------------------------------
# Domain enums live on the ENTITY — ``flow_sdk.builtin.task`` declares
# ``TaskStatus`` / ``TaskType`` / ``TaskKind``. This module used to carry a second
# copy of all three (unused here, and free to drift from the ones the entity
# actually validates against); import them from there if this module ever needs
# one. One type registry, one enum per typed value.
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Walker — one TASK FSRef per tasks/<name>/ folder
# ---------------------------------------------------------------------------


def _unwrap_task_envelope(data: Any) -> dict:
    """Some manifest.json files wrap the task fields under a ``data`` key
    (legacy/external format). Unwrap when present so callers see flat fields."""
    if (
        isinstance(data, dict)
        and isinstance(data.get("data"), dict)
        and ("id" in data["data"] or "task_id" in data["data"])
    ):
        return data["data"]
    return data if isinstance(data, dict) else {}


def _legacy_manifest(task_dir: Path) -> Path | None:
    for name in ("header.json", "manifest.json"):
        p = task_dir / name
        if p.is_file():
            return p
    return None


def _read_legacy_data(manifest: Path) -> dict:
    try:
        return _unwrap_task_envelope(json.loads(manifest.read_text(encoding="utf-8")))
    except (json.JSONDecodeError, OSError):
        return {}


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
    """`.flow/id` capsule (gen_id stamped it) → validated task.md frontmatter id →
    folder-name-derived v5 (transitional). Matches TypeInfo reader precedence."""
    cap = read_folder_capsule_id(task_dir)
    if cap:
        return cap
    fm_id = read_frontmatter_id_from_yaml(fields)
    if fm_id and is_valid_entity_id(fm_id):
        return fm_id
    return _mint_task_id(task_dir.name)


# ---------------------------------------------------------------------------
# Id helper
# ---------------------------------------------------------------------------


def task_id_from_folder(ref: FSRef | Path) -> object | None:
    """Read capsule, task.md, then legacy manifest without writing/backfill."""
    path = Path(getattr(ref, "_path", ref))
    task_dir = path if path.is_dir() else path.parent
    cap = read_folder_capsule_id(task_dir)
    if cap:
        return cap
    fields = _read_task_md_fields(task_dir / "task.md")
    for candidate in (fields.get("id"), fields.get("asset_id")):
        if is_valid_entity_id(candidate):
            return candidate
    manifest = _legacy_manifest(task_dir)
    data = _read_legacy_data(manifest) if manifest else {}
    for candidate in (data.get("task_id"), data.get("id")):
        if is_valid_entity_id(candidate):
            return candidate
    return None


# ---------------------------------------------------------------------------
# Content hash — mtime across inner files (folder mtime misses child edits)
# ---------------------------------------------------------------------------


def task_asset_hash(ref: FSRef) -> float:
    base = ref._path if ref._path.is_dir() else ref._path.parent
    ts = 0.0
    for name in ("task.md", "spec.md", "header.json", "manifest.json"):
        try:
            ts = max(ts, (base / name).stat().st_mtime)
        except OSError:
            pass
    return ts


# ---------------------------------------------------------------------------
# Extractor
# ---------------------------------------------------------------------------


def _strip_leading_heading(body: str) -> str:
    """Drop a single leading ``# Title`` line written by ``_task_default_body``."""
    lines = body.lstrip("\n").splitlines()
    if lines and lines[0].startswith("# "):
        lines = lines[1:]
    return "\n".join(lines).strip()


def _extract_from_task_md(ref: FSRef, task_md: Path, task_dir: Path, resolved_id: str) -> list:
    from flow_sdk.fs_store.fs_record import FSRecord  # local import avoids circular

    try:
        text = task_md.read_text(encoding="utf-8")
    except OSError:
        return []
    fields = _parse_frontmatter_fields(text)
    kwargs: dict[str, Any] = {
        "type": RecordType.TASK,
        "id": resolved_id,
        "name": str(fields.get("title") or task_dir.name),
        "title": str(fields.get("title") or task_dir.name),
        "status": str(fields.get("status") or "to_do"),
    }
    body = _strip_leading_heading(_extract_body(text))
    if body:
        kwargs["description"] = body
    for key in TASK_FRONTMATTER_FIELDS:  # single source of truth (also the writer's)
        if fields.get(key) is not None:
            kwargs[key] = fields[key]
    rec = FSRecord(**kwargs)
    rec.asset_ref = FSRef(task_dir.resolve())
    if ref.scope:
        rec.scope = ref.scope
    return [rec]


def _extract_from_manifest(ref: FSRef, manifest: Path, task_dir: Path, resolved_id: str) -> list:
    from flow_sdk.fs_store.fs_record import FSRecord  # local import avoids circular

    data = _read_legacy_data(manifest)
    name = data.get("title") or data.get("name") or task_dir.name
    status = data.get("status") or "to_do"
    kwargs: dict[str, Any] = {
        "type": RecordType.TASK,
        "id": resolved_id,
        "name": name,
        "title": name,
        "status": status,
    }
    # Same canonical field set as ``task.md`` (plus the two manifest-only keys),
    # so the legacy path can't drift from it. Sender-local keys
    # (my_process_id/project_root) are excluded BY CONSTRUCTION: the constant is
    # a whitelist that omits them. A second hand-written list here is what let
    # ``archived_at`` go missing, silently resurrecting archived tasks as active
    # ``to_do`` rows on every reindex.
    for key in (*TASK_FRONTMATTER_FIELDS, "description", "objective"):
        if data.get(key) is not None:
            kwargs[key] = data[key]
    rec = FSRecord(**kwargs)
    # Point asset_ref at the FOLDER so the next save materializes task.md and
    # self-heals the legacy folder into the new layout.
    rec.asset_ref = FSRef(task_dir.resolve())
    if ref.scope:
        rec.scope = ref.scope
    return [rec]


def extract_task(ref: FSRef, resolved_id: str) -> list:
    """Parse a task folder (``task.md``, or legacy ``header.json``) into a Record."""
    path = ref._path
    if path.is_dir():
        task_md = path / "task.md"
        if task_md.is_file():
            return _extract_from_task_md(ref, task_md, path, resolved_id)
        manifest = _legacy_manifest(path)
        if manifest is not None:
            return _extract_from_manifest(ref, manifest, path, resolved_id)
        return []
    # Legacy: ref points directly at a header.json/manifest.json file.
    if path.is_file():
        return _extract_from_manifest(ref, path, path.parent, resolved_id)
    return []
