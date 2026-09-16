"""Filesystem contracts independent of application entities."""
from __future__ import annotations

from pathlib import Path

from flow_sdk.assets.frontmatter import _extract_frontmatter, _yaml_load
from flow_sdk.fs_store.fs_ref import FSRef


def task_asset_hash(ref: FSRef) -> float:
    base = ref._path if ref._path.is_dir() else ref._path.parent
    ts = 0.0
    for name in ("task.md", "spec.md"):
        try:
            ts = max(ts, (base / name).stat().st_mtime)
        except OSError:
            pass
    return ts


def derive_task(data: dict, root: Path, header_raw: dict) -> None:
    """The title falls back to the folder; the name is the title."""
    data["title"] = data.get("title") or root.name
    data["name"] = data["title"]




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
