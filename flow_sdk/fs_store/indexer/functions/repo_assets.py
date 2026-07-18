"""Walker for repo assets — the recursive ``agentic-assets/<type>`` hierarchy.

A repo asset lives at ``<container>/agentic-assets/<type>/<name>``; its children
nest in the asset's own ``agentic-assets/`` subfolder, recursively. This single
walker discovers the whole nested tree in ONE pass (in-function recursion) and
emits one ``FSRef`` per asset at every depth, so the indexer materializes each via
its own type's ``from_disk_fn``. Parentage is NOT derived from location here — it
rides in each asset's ``metadata.json`` ``parent_type_id`` (the source of truth);
this walker only discovers folders so their bytes get indexed at all.

Registered on the scope-root input types with ``output_type=None`` (always runs —
repo discovery is a cheap dir scan and the walker emits many types, so per-type
output gating doesn't apply). Mirrors the single-pass shape of ``skill_fn``.
"""
from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.placement import AGENTIC_ASSETS_DIR
from flow_sdk.schema.types import EntityType

# Backstop against pathological nesting / symlink loops (physical folders can't
# cycle without symlinks, which the copy/restore guards already reject).
_MAX_DEPTH = 32


def repo_assets_fn(nodes: list[FSRef], opts: IndexerOptions) -> list[FSRef]:
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    # family (the <type> subdir) → the registered TypeInfo, resolved once so the
    # walk knows each type's layout (folder asset dir vs file asset) + record type.
    type_infos = {
        fam: SchemaRegistry.get(tn) for fam, tn in SchemaRegistry.repo_family_to_type().items()
    }
    type_infos = {fam: info for fam, info in type_infos.items() if info is not None}
    if not type_infos:
        return []
    out: list[FSRef] = []
    for node in nodes:
        _scan(Path(node.path), node, type_infos, out, 0)
    return out


def _scan(
    container: Path,
    parent_ref: "FSRef",
    type_infos: dict,
    out: list[FSRef],
    depth: int,
) -> None:
    # Each asset folder/file has one physical location and can't alias without a
    # symlink (rejected by the copy/restore guards), so a visited-set would never
    # dedup; _MAX_DEPTH is the only backstop needed.
    if depth >= _MAX_DEPTH:
        return
    aa = container / AGENTIC_ASSETS_DIR
    if not aa.is_dir():
        return
    for type_dir in sorted(aa.iterdir()):
        if not type_dir.is_dir():
            continue
        info = type_infos.get(type_dir.name)
        if info is None:
            continue
        record_type = EntityType(info.type_name)
        is_folder = info.main_layout == "folder"
        for entry in sorted(type_dir.iterdir()):
            if is_folder:
                # Folder asset (spec/task/deck…): the <name>/ dir is the asset
                # folder. The FSRef points where the type's convention puts it —
                # the bare folder (skill/task style) or the inner main_file
                # (spec style) — via ``asset_ref_for``. Recursion descends into
                # the FOLDER for nested children.
                if not entry.is_dir():
                    continue
                ref = FSRef(info.asset_ref_for(entry), record_type=record_type, parent=parent_ref)
                out.append(ref)
                _scan(entry, ref, type_infos, out, depth + 1)
            elif entry.is_file() and entry.suffix == info.main_ext:
                # File asset (markdown/prompt…): the <name>.<ext> file IS the
                # asset — a leaf, no nesting.
                out.append(FSRef(entry, record_type=record_type, parent=parent_ref))
