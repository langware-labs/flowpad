"""Filesystem contracts independent of application entities."""

from __future__ import annotations

from pathlib import Path


def derive_webapp(data: dict, root: Path, header_raw: dict) -> None:
    if not data.get("name"):
        data["name"] = root.name



def webapp_asset_hash(ref) -> int:
    """Freshness of a web app: its ``webapp.json``'s mtime. The folder's own mtime does not move when the
    manifest is edited in place, so a changed start command (the setup-fixer's repair, a person's edit)
    would otherwise never re-index."""
    try:
        return (ref._path / "webapp.json").stat().st_mtime_ns
    except OSError:
        return 0
