"""Extractor + helpers for SKILL records.

A skill is a folder containing ``SKILL.md`` (markdown + YAML frontmatter) and/or
``skill.yaml`` / ``skill.yml``. Discovery is the type's declared ``walk``
(``skill_type_info.py``, shape ``Folder(main="SKILL.md")``): a yaml-only folder
in a skills mount is collected as a scan issue rather than indexed. Replaces
the deleted ``SkillRecord`` subclass.

Public helpers used outside the indexer:
- ``parse_skill_yaml_from_dir(path)`` — yaml/frontmatter parse
- ``extract_skill(ref)`` — parser_fn entry point
- ``skill_id(ref)`` — compatibility read helper
- ``skill_asset_hash(ref)`` — folder-content mtime
- ``resolve_skill_name(yaml_fields, folder_name)`` — display-name picker
- ``read_frontmatter_id_from_yaml(yaml_fields)`` — id extractor
- ``skill_id_from_name(name)`` — deterministic uuid5 from name
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.fs_store.indexer._frontmatter import (
    _extract_frontmatter,
    _yaml_load,
)
from flow_sdk.fs_store.indexer.functions._folder_capsule import (
    read_folder_capsule_id,
)
from flow_sdk.fs_store.record_types import RecordType

# The files whose presence makes a folder a skill; SKILL.md is the main doc.
# Both cases of the doc are accepted (SKILL.md is canonical; skill.md tolerated).
SKILL_INNER_FILES = ("SKILL.md", "skill.md", "skill.yaml", "skill.yml")


def folder_is_skill(folder: Path) -> bool:
    """True if ``folder`` directly contains a skill marker file — the loose
    "is this a skill?" predicate the OpenCode config generator asks. The
    indexer itself classifies by shape (``SKILL.md``), not by this."""
    return any((folder / name).exists() for name in SKILL_INNER_FILES)


# ── id + frontmatter helpers ─────────────────────────────────────────────────


def read_frontmatter_id_from_yaml(yaml_fields: dict) -> str | None:
    """Pick a VALID (v4/v5) `id`/`asset_id` from a parsed yaml/frontmatter dict.

    Routes through ``adopt_entity_id`` (validate-on-adopt) so a non-uuid /
    foreign frontmatter id (a v7, a hand-typed token) is rejected → ``None`` and
    the caller mints a fresh v4 into the capsule instead of adopting garbage.
    """
    from flow_sdk.api.api_types.identifier import adopt_entity_id  # noqa: PLC0415
    for candidate in (yaml_fields.get("id"), yaml_fields.get("asset_id")):
        adopted = adopt_entity_id(candidate)
        if adopted:
            return adopted
    return None


def resolve_skill_name(yaml_fields: dict, folder_name: str) -> str:
    """Pick the skill's display name: yaml.name first, else folder name."""
    yaml_name = yaml_fields.get("name")
    if isinstance(yaml_name, str) and yaml_name.strip():
        return yaml_name.strip()
    return folder_name.split("-@", 1)[-1] if "-@" in folder_name else folder_name


def skill_id_from_name(name: str) -> str:
    """Stable uuid5 derived from the skill name."""
    return mint_uuid(f"{RecordType.SKILL}:{name}", namespace=uuid.NAMESPACE_DNS)


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


def skill_id(ref: FSRef, yaml_fields: dict[str, Any] | None = None) -> str:
    """Cheap id (no write): `.flow/id` capsule, else valid frontmatter id, else
    the transitional uuid5(name) read fallback for legacy rows.

    ``yaml_fields`` lets a caller that has ALREADY parsed the folder's
    yaml/frontmatter hand it in, so the fallback path doesn't stat and re-parse
    the same files a second time. Omitted, they are read on demand as before —
    the id policy itself stays owned here either way."""
    path = ref._path
    if path.is_dir():
        cap = read_folder_capsule_id(path)
        if cap:
            return cap
        if yaml_fields is None:
            yaml_fields = parse_skill_yaml_from_dir(path)
        fm_id = read_frontmatter_id_from_yaml(yaml_fields)
        if fm_id:
            return fm_id
        return skill_id_from_name(resolve_skill_name(yaml_fields, path.name))
    return path.name.split("-@", 1)[-1] if "-@" in path.name else path.name


def skill_id_from_folder(ref: FSRef | Path) -> object | None:
    """Read the capsule, then legacy SKILL.md/yaml fields, without backfill."""
    path = Path(getattr(ref, "_path", ref))
    cap = read_folder_capsule_id(path)
    if cap:
        return cap
    fields = parse_skill_yaml_from_dir(path)
    return read_frontmatter_id_from_yaml(fields)


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


def derive_skill(data: dict, root: Path, header_raw: dict) -> None:
    """The folder's facts: the header may come from ``skill.yaml``/``skill.yml``
    rather than ``SKILL.md`` (the yaml wins where present, as before), the
    name falls back to the folder (``-@`` suffix stripped), and the raw yaml
    dict rides ``metadata``."""
    fields = parse_skill_yaml_from_dir(root) if root.is_dir() else {}
    data["name"] = resolve_skill_name(fields, root.name)
    if isinstance(fields.get("description"), str):
        data["description"] = fields["description"]
    if fields:
        data["metadata"] = fields
