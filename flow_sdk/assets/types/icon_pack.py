"""Indexing an ``icon_pack`` folder IS registering it with the icon registry."""

from __future__ import annotations

from flow_sdk.assets.identity import main_file_mtime
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.icons.registry import MANIFEST, icons


def extract_icon_pack(ref: FSRef, resolved_id: str) -> list[FSRecord]:
    """One row per pack folder. Problems ride the row as ``error`` -- the pack
    still indexes, so a broken one is findable rather than silently absent."""
    path = ref._path
    if not (path / MANIFEST).is_file():
        return []
    problems = icons.add_asset_pack(path)
    found = icons.asset_pack(path)
    spec = found.spec if found is not None else None
    name = spec.kind if spec is not None else path.name
    rec = FSRecord(
        type=RecordType.ICON_PACK,
        id=resolved_id,
        name=name,
        status="active",
        description=spec.license if spec is not None else "",
        icon_count=len(spec.icons) if spec is not None else 0,
        error="\n".join(problems),
        content="\n".join([name, *(f"{name}.{i.kind}" for i in (spec.icons if spec else []))]),
        metadata={"problems": problems},
    )
    object.__setattr__(rec, "_asset_ref", FSRef(path.resolve()))
    return [rec]


def icon_pack_asset_hash(ref: FSRef) -> int:
    """Fresh while icon_pack.json and the files beside it and under assets/ are unchanged."""
    stamp = main_file_mtime(ref, MANIFEST)
    try:
        for child in (*ref._path.iterdir(), *(ref._path / "assets").glob("*")):
            if child.is_file():
                stamp = max(stamp, child.stat().st_mtime_ns)
    except OSError:
        pass
    return stamp
