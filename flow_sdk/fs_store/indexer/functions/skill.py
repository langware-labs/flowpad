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
from flow_sdk.fs_store.indexer._frontmatter import (
    _extract_body,
    _extract_frontmatter,
    _yaml_load,
)
from flow_sdk.fs_store.indexer.functions._folder_capsule import (
    folder_capsule_gen_id,
    read_folder_capsule_id,
)
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType

# The files whose presence makes a folder a skill; SKILL.md is the main doc.
SKILL_INNER_FILES = ("SKILL.md", "skill.yaml", "skill.yml")


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
            if not any((entry / name).exists() for name in SKILL_INNER_FILES):
                continue
            key = str(entry.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(FSRef(entry, record_type=RecordType.SKILL, parent=node))
    return out


# ── id + frontmatter helpers ─────────────────────────────────────────────────


def read_frontmatter_id_from_yaml(yaml_fields: dict) -> str | None:
    """Pick a VALID (v4/v5) `id`/`asset_id` from a parsed yaml/frontmatter dict.

    Routes through ``adopt_entity_id`` (validate-on-adopt) so a non-uuid /
    foreign frontmatter id (a v7, a hand-typed token) is rejected → ``None`` and
    the caller mints a fresh v4 into the capsule instead of adopting garbage.
    """
    from flow_sdk.fs_store.identifier import adopt_entity_id  # noqa: PLC0415
    return adopt_entity_id(yaml_fields.get("id") or yaml_fields.get("asset_id"))


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
    """Cheap id (no write): `.flow/id` capsule, else valid frontmatter id, else
    the transitional uuid5(name) read fallback for legacy rows."""
    path = ref._path
    if path.is_dir():
        cap = read_folder_capsule_id(path)
        if cap:
            return cap
        yaml_fields = parse_skill_yaml_from_dir(path)
        fm_id = read_frontmatter_id_from_yaml(yaml_fields)
        if fm_id:
            return fm_id
        return skill_id_from_name(resolve_skill_name(yaml_fields, path.name))
    return path.name.split("-@", 1)[-1] if "-@" in path.name else path.name


def skill_gen_id(ref: FSRef) -> str:
    """Adopt the skill's id from its capsule, else mint a fresh v4 (idempotent).

    Read precedence: (1) the `.flow/id` folder capsule (authoritative, portable);
    (2) a VALID (v4/v5) `id:` in SKILL.md / skill.yaml frontmatter — adopted and
    BACKFILLED into `.flow/id` (migrates the skill onto the capsule without
    changing its id); (3) miss → a fresh random **v4** written to `.flow/id`.
    No longer name-derives (`uuid5("skill:name")` collided across machines), and
    now persists for yaml-based skills too (the old code skipped the write).
    """
    path = ref._path
    if not path.is_dir():
        return skill_id(ref)
    yaml_fields = parse_skill_yaml_from_dir(path)
    return folder_capsule_gen_id(path, yaml_fields.get("id"), yaml_fields.get("asset_id"))


def skill_asset_hash(ref: FSRef) -> float:
    """mtime across inner content files (SKILL.md, skill.yaml, skill.yml).

    Folder mtime doesn't update when child file contents are edited.
    """
    base = ref._path
    ts = 0.0
    for name in SKILL_INNER_FILES:
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
    # Single-file index paths hand us the inner doc, not the skill folder.
    # Normalize, or every skill id-derives from the constant "SKILL.md"
    # filename and collides (VIBE-004) with a file-valued asset_ref (VIBE-007).
    if not path.is_dir() and path.name in SKILL_INNER_FILES:
        path = path.parent
    yaml_fields = parse_skill_yaml_from_dir(path) if path.is_dir() else {}
    skill_name = resolve_skill_name(yaml_fields, path.name)
    rec_id = (
        (read_folder_capsule_id(path) if path.is_dir() else None)
        or read_frontmatter_id_from_yaml(yaml_fields)
        or skill_id_from_name(skill_name)  # transitional read fallback for legacy rows
    )
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
