"""Walker for repo assets — the recursive ``agentic-assets/<type>`` hierarchy.

A repo asset lives at ``<container>/agentic-assets/<type>/<name>``; its children
nest in the asset's own ``agentic-assets/`` subfolder, recursively. This single
walker discovers the whole nested tree in ONE pass (in-function recursion) and
emits one ``FSRef`` per asset at every depth, so the indexer materializes each via
its own type's ``from_disk_fn``. Parentage is NOT derived from location here — it
rides in each asset's ``metadata.json`` ``parent_type_id`` (the source of truth);
this walker only discovers folders so their bytes get indexed at all.

Registered on the scope-root input types with the explicit set of repository
record types it can emit. Mirrors the single-pass shape of ``skill_fn``.
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
    from flow_sdk.fs_store.schema_registry import LayoutKind, SchemaRegistry  # noqa: PLC0415

    # family (the <type> subdir) → its TypeInfo (layout + marker + record type).
    type_infos = SchemaRegistry.repo_family_to_info()
    if not type_infos:
        return []
    requested_types = set(opts.types) if opts.types is not None else None
    out: list[FSRef] = []

    def scan(container: Path, parent_ref: FSRef, depth: int) -> None:
        # A physical folder/file can't alias without a symlink (rejected by the
        # copy/restore guards), so a visited-set would never dedup; _MAX_DEPTH is
        # the only backstop needed.
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
            wanted = requested_types is None or record_type in requested_types
            for entry in sorted(type_dir.iterdir()):
                # The type's own classifier is the "is this really an asset?"
                # gate (marker file present, right extension); ``layout.ref`` is
                # where the type's convention points the FSRef.
                layout = info.layout_of(entry, verify=True)
                if layout.kind is LayoutKind.FOLDER:
                    # Recursion descends into the FOLDER for nested children.
                    ref = FSRef(layout.ref, record_type=record_type, parent=parent_ref)
                    if wanted:
                        out.append(ref)
                    # Traverse unrequested folder assets too: a requested SPEC
                    # may be nested below an unrequested TASK/DECK parent.
                    scan(entry, ref, depth + 1)
                elif layout.kind is LayoutKind.FILE:
                    # File asset (markdown/prompt…): the <name>.<ext> file IS the
                    # asset — a leaf, no nesting.
                    if wanted:
                        out.append(FSRef(entry, record_type=record_type, parent=parent_ref))

    for node in nodes:
        scan(Path(node.path), node, 0)
    return out
