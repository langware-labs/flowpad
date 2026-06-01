"""Walker + extractor + helpers for SKILL records.

A skill is a folder containing ``SKILL.md`` (markdown + YAML frontmatter) and/or
``skill.yaml`` / ``skill.yml``. Replaces the deleted ``SkillRecord`` subclass.

Public helpers used outside the indexer:
- ``parse_skill_yaml_from_dir(path)`` — yaml/frontmatter parse
- ``extract_skill(ref)`` — parser_fn entry point
- ``skill_id(ref)`` / ``skill_gen_id(ref)`` — id helpers
- ``skill_asset_hash(ref)`` — folder-content mtime
- ``resolve_skill_name(yaml_fields, folder_name)`` — display-name picker
- ``read_frontmatter_id_from_yaml(yaml_fields)`` — id extractor
- ``skill_id_from_name(name)`` — deterministic uuid5 from name
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry, TypeInfo

from flow_sdk.fs_store.indexer._frontmatter import (
    _extract_body,
    _extract_frontmatter,
    _render_frontmatter,
    _yaml_load,
)


def skill_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        skills_dir = Path(node.path) / ".claude" / "skills"
        if not skills_dir.is_dir():
            continue
        for entry in sorted(skills_dir.iterdir()):
            if not entry.is_dir():
                continue
            if (
                not (entry / "SKILL.md").exists()
                and not (entry / "skill.yaml").exists()
                and not (entry / "skill.yml").exists()
            ):
                continue
            key = str(entry.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(FSRef(entry, record_type=RecordType.SKILL, parent=node))
    return out


# ── id + frontmatter helpers ─────────────────────────────────────────────────


def read_frontmatter_id_from_yaml(yaml_fields: dict) -> str | None:
    """Pick `id` (or legacy `asset_id`) from a parsed yaml/frontmatter dict."""
    raw = yaml_fields.get("id") or yaml_fields.get("asset_id")
    return str(raw).strip() if isinstance(raw, str) and raw.strip() else None


def resolve_skill_name(yaml_fields: dict, folder_name: str) -> str:
    """Pick the skill's display name: yaml.name first, else folder name."""
    yaml_name = yaml_fields.get("name")
    if isinstance(yaml_name, str) and yaml_name.strip():
        return yaml_name.strip()
    return folder_name.split("-@", 1)[-1] if "-@" in folder_name else folder_name


def skill_id_from_name(name: str) -> str:
    """Stable uuid5 derived from the skill name."""
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{RecordType.SKILL}:{name}"))


def parse_skill_yaml_from_dir(skill_dir: Path) -> dict[str, Any]:
    """Load YAML fields from skill.yaml / skill.yml / SKILL.md frontmatter."""
    for source in (skill_dir / "skill.yaml", skill_dir / "skill.yml"):
        if source.exists():
            return _yaml_load(source.read_text(encoding="utf-8")) or {}
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        return {}
    fm = _extract_frontmatter(skill_md.read_text(encoding="utf-8"))
    if not fm:
        return {}
    return _yaml_load(fm) or {}


def skill_id(ref: FSRef) -> str:
    """Cheap id: frontmatter id; else uuid5(name)."""
    path = ref._path
    if path.is_dir():
        yaml_fields = parse_skill_yaml_from_dir(path)
        fm_id = read_frontmatter_id_from_yaml(yaml_fields)
        if fm_id:
            return fm_id
        return skill_id_from_name(resolve_skill_name(yaml_fields, path.name))
    return path.name.split("-@", 1)[-1] if "-@" in path.name else path.name


def skill_gen_id(ref: FSRef) -> str:
    """Mint+write id into SKILL.md frontmatter (idempotent).

    For yaml-based skills (skill.yaml/.yml present), skip the write and
    return the derived id — touching arbitrary yaml files belongs to a
    separate change. For SKILL.md-only skills, write the derived id into
    the frontmatter so future scans return the same id.
    """
    path = ref._path
    if not path.is_dir():
        return skill_id(ref)
    yaml_fields = parse_skill_yaml_from_dir(path)
    existing = read_frontmatter_id_from_yaml(yaml_fields)
    if existing:
        return existing
    skill_name = resolve_skill_name(yaml_fields, path.name)
    new_id = skill_id_from_name(skill_name)
    if (path / "skill.yaml").exists() or (path / "skill.yml").exists():
        return new_id
    skill_md = path / "SKILL.md"
    if not skill_md.exists():
        return new_id
    try:
        text = skill_md.read_text(encoding="utf-8")
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
        skill_md.write_text(
            _render_frontmatter(merged) + "\n\n" + body + ("\n" if body and not body.endswith("\n") else ""),
            encoding="utf-8",
        )
    except OSError:
        pass
    return new_id


def skill_asset_hash(ref: FSRef) -> float:
    """mtime across inner content files (SKILL.md, skill.yaml, skill.yml).

    Folder mtime doesn't update when child file contents are edited.
    """
    base = ref._path
    ts = 0.0
    for name in ("SKILL.md", "skill.yaml", "skill.yml"):
        try:
            ts = max(ts, (base / name).stat().st_mtime)
        except OSError:
            pass
    return ts


def extract_skill(ref: FSRef) -> list[FSRecord]:
    """Parse a skill folder into a Record. Replaces ``SkillRecord._from_fsref_sync``.

    Eagerly populates: id, name, description, content (name + description +
    SKILL.md body for FTS), body, metadata (yaml fields).
    """
    path = ref._path
    yaml_fields = parse_skill_yaml_from_dir(path) if path.is_dir() else {}
    skill_name = resolve_skill_name(yaml_fields, path.name)
    rec_id = read_frontmatter_id_from_yaml(yaml_fields) or skill_id_from_name(skill_name)
    description = ""
    if isinstance(yaml_fields.get("description"), str):
        description = yaml_fields["description"]

    body = ""
    skill_md = path / "SKILL.md"
    if skill_md.exists():
        try:
            text = skill_md.read_text(encoding="utf-8")
            body = _extract_body(text)
        except OSError:
            pass

    content_parts: list[str] = []
    if skill_name:
        content_parts.append(skill_name)
    if description:
        content_parts.append(description)
    if body:
        content_parts.append(body)
    content = "\n".join(content_parts) if content_parts else ""

    rec_kwargs: dict = {
        "name": skill_name,
        "status": "active",
        "content": content,
        "body": body,
    }
    if description:
        rec_kwargs["description"] = description
    if yaml_fields:
        rec_kwargs["metadata"] = yaml_fields
    if ref.scope:
        rec_kwargs["scope"] = ref.scope

    rec = FSRecord(RecordType.SKILL, rec_id, **rec_kwargs)
    rec.asset_ref = FSRef(path.resolve())
    return [rec]

# Type metadata now lives in flow_sdk/schema/type_info/skill_info.py.
# This module provides the walker + slot functions only.
