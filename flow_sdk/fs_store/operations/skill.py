"""Operations on SKILL records — copy mutations + lookup helpers."""
from __future__ import annotations

import shutil
from pathlib import Path

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.indexer.functions.skill import extract_skill, parse_skill_yaml_from_dir
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_paths import get_default_records_root, record_stem
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.instance_settings import get_instance_settings


_META_JSON = "metadata.json"


def _source_dir(rec) -> Path:
    """Resolve the skill's source folder from asset_ref / record_dir."""
    ar = rec.asset_ref
    if ar is not None:
        return ar._path
    rd = getattr(rec, "record_dir", None)
    if rd is None:
        raise ValueError("Skill record has no source directory")
    return rd


def _pick_skill_name(rec, source_dir: Path) -> str:
    """Display name: yaml.name → rec.name → rec.id → folder name."""
    yaml_fields = parse_skill_yaml_from_dir(source_dir)
    yaml_name = yaml_fields.get("name")
    if isinstance(yaml_name, str) and yaml_name.strip():
        return yaml_name.strip()
    return getattr(rec, "name", None) or rec.id or source_dir.name


def copy_skill_to(rec, destination_root: Path) -> Path:
    """Copy the skill folder to ``destination_root / <name>``.

    Excludes legacy ``.flow_record`` and ``record.json`` leftovers.
    Overwrites an existing destination of the same name.
    """
    source_dir = _source_dir(rec)
    if not (source_dir / "SKILL.md").exists():
        raise FileNotFoundError(f"Missing SKILL.md in {source_dir}")

    skill_name = _pick_skill_name(rec, source_dir)
    destination_root.mkdir(parents=True, exist_ok=True)
    destination = destination_root / skill_name
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(
        source_dir,
        destination,
        ignore=shutil.ignore_patterns(".flow_record", "record.json"),
    )
    return destination


def copy_skill_to_user_home(rec) -> Path:
    return copy_skill_to(rec, get_instance_settings().claude_skills_dir)


def copy_skill_to_project(rec, project_dir: str | Path) -> Path:
    return copy_skill_to(rec, Path(project_dir) / ".claude" / "skills")


def get_skill(uid: str) -> FSRecord | None:
    """O(1) lookup of a SKILL record by id."""
    records_root = get_default_records_root()
    stem = record_stem(RecordType.SKILL, uid)
    folder = records_root / RecordType.SKILL / stem
    if not folder.is_dir():
        return None
    if (folder / _META_JSON).exists():
        try:
            return load_skill_record(folder)
        except OSError:
            return None
    return None


def load_skill_record(path: str | Path) -> FSRecord:
    """Load a skill record from a live skill folder or a shadow records folder."""
    p = Path(path)
    if not p.is_dir():
        return FSRecord.load_record(path)
    if (p / _META_JSON).exists() or (p / "data.json").exists():
        return FSRecord.load_record(path)
    # Live skill dir — use extractor.
    records = extract_skill(FSRef(p.resolve()))
    if not records:
        return FSRecord(type=RecordType.SKILL, status="active")
    return records[0]
