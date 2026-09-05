"""The ONE generic walker — driven by a type's ``Walk`` declarations.

A type that declares ``walk=`` (``flow_sdk.schema.layout.Walk``) is scanned by
``layout_walker(info)``: for each root node the walker resolves the walk's
mounts, asks the type's SHAPE whether each entry is an instance
(``shape.locate(entry, verify=True)``) and yields one ``FSRef`` per hit,
deduped. A near-miss in a Folder type's mount (a ``skills/<x>/`` with no
``SKILL.md``) is logged as a ``ScanIssue``, never silently dropped.

An ``anywhere`` walk runs over FOLDER scaffold nodes and leaves alone every
entry sitting inside a mount another walk of the type covers (a
``.claude/skills/<x>`` is the harness walk's, not the folder walk's).
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import TYPE_CHECKING

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerFunc, IndexerOptions
from flow_sdk.fs_store.indexer.index_log import (
    UNCLASSIFIED_IN_FAMILY_DIR,
    ScanIssue,
    append_scan_issue,
)
from flow_sdk.fs_store.placement import mount_matches, scan_mounts
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.schema.layout import File, Folder, LayoutKind, Walk

if TYPE_CHECKING:
    from flow_sdk.fs_store.schema_registry import TypeInfo

logger = logging.getLogger(__name__)


def walk_roots(info: "TypeInfo") -> tuple[RecordType, ...]:
    """Every root node kind the type's walks hang on, first-seen order."""
    out: list[RecordType] = []
    for walk in info.walk:
        for root in walk.roots:
            rt = RecordType(root)
            if rt not in out:
                out.append(rt)
    return tuple(out)


def is_appledouble(name: str) -> bool:
    """macOS AppleDouble sidecars (``._foo.md``) share the extension of the
    file they shadow but hold a binary resource fork, never an asset."""
    return name.startswith("._")


def first_seen(seen: set[str], path: Path, *, resolve: bool = False) -> bool:
    """Record ``path`` in ``seen``; True the first time. ``resolve`` keys on
    the real path (a symlinked mount), else on the spelling itself."""
    key = str(path.resolve()) if resolve else os.path.normcase(str(path))
    if key in seen:
        return False
    seen.add(key)
    return True


def _under_mount(path: Path, mounts: tuple[str, ...]) -> bool:
    """True when ``path``'s parent IS one of ``mounts`` — the entry belongs to
    that mount's walk."""
    parent_parts = path.parent.parts
    return any(mount_matches(parent_parts, Path(mount).parts) for mount in mounts)


def _resolve_mount(root: Path, mount: str) -> list[Path]:
    if "*" in mount:
        return sorted(p for p in root.glob(mount) if p.is_dir())
    return [root / mount]


def _candidates(mount: Path, shape: File | Folder, *, recursive: bool) -> list[Path]:
    """The entries to classify under ``mount`` — sorted, so emission order is
    deterministic. A File shape narrows the recursive glob to its extension."""
    if not mount.is_dir():
        return []
    try:
        if recursive:
            pattern = f"*{shape.ext}" if isinstance(shape, File) else "*"
            return sorted(mount.rglob(pattern))
        return sorted(mount.iterdir())
    except OSError:
        return []


def layout_walker(info: "TypeInfo") -> IndexerFunc:
    """The indexer function for a declared type. Registered on every root in
    ``walk_roots(info)``; each node is served by the walks whose ``roots``
    name its record type, so one walker object covers all of them."""
    shape = info.shape
    record_type = RecordType(info.type_name)
    if not info.walk:
        raise ValueError(f"{info.type_name}: no walk declared")
    derived = scan_mounts(*info._resolved_layout)   # what a walk with no mounts looks in
    owned = info.scan_mounts                        # what the anywhere walk leaves alone
    by_root: dict[RecordType, list[Walk]] = {}
    for walk in info.walk:
        for root in walk.roots:
            by_root.setdefault(RecordType(root), []).append(walk)

    def emit(path: Path, node: FSRef, out: list[FSRef], seen: set[str], *, resolve: bool = False) -> bool:
        """True when ``path`` is the shape (emitted unless already seen)."""
        layout = shape.locate(path, verify=True)
        if layout.kind is LayoutKind.NONE:
            return False
        if first_seen(seen, layout.ref, resolve=resolve):
            out.append(FSRef(layout.ref, record_type=record_type, parent=node))
        return True

    def walk_anywhere(node: FSRef, out: list[FSRef], seen: set[str]) -> None:
        here = Path(node.path)
        if isinstance(shape, Folder):
            if not _under_mount(here, owned):
                emit(here, node, out, seen)
            return
        for entry in _candidates(here, shape, recursive=False):
            if not is_appledouble(entry.name) and not _under_mount(entry, owned):
                emit(entry, node, out, seen)

    def walk_mount(mount: Path, node: FSRef, walk: Walk, out: list[FSRef], seen: set[str]) -> None:
        resolve = mount.is_symlink()
        for entry in _candidates(mount, shape, recursive=walk.recursive):
            if is_appledouble(entry.name):
                continue
            if not emit(entry, node, out, seen, resolve=resolve) and not walk.recursive and isinstance(shape, Folder):
                _collect_near_miss(entry, mount)

    def _collect_near_miss(entry: Path, mount: Path) -> None:
        # A directory in a Folder type's family mount that is not the shape
        # (no main document) is a near-miss the owner should see. A file
        # there (a README) or a dot-dir is not one.
        if entry.name.startswith(".") or not entry.is_dir():
            return
        append_scan_issue(
            ScanIssue(
                path=str(entry),
                kind=UNCLASSIFIED_IN_FAMILY_DIR,
                detail=f"directory in {mount.name}/ without {shape.main}",
                type_name=info.type_name,
            )
        )

    def walker(nodes: list[FSRef], opts: IndexerOptions) -> list[FSRef]:
        out: list[FSRef] = []
        seen: set[str] = set()
        for node in nodes:
            for walk in by_root.get(node.record_type, ()):
                if walk.anywhere:
                    walk_anywhere(node, out, seen)
                    continue
                root = Path(node.path)
                for mount in walk.mounts or derived:
                    for mount_dir in _resolve_mount(root, mount):
                        walk_mount(mount_dir, node, walk, out, seen)
        return out

    walker.__name__ = walker.__qualname__ = f"layout_walker[{info.type_name}]"
    return walker


def walker_for(type_name: str) -> IndexerFunc:
    """``layout_walker`` for a registered type name — the test/handler entry."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    info = SchemaRegistry.get(type_name)
    if info is None:
        raise KeyError(f"unknown type {type_name!r}")
    return layout_walker(info)
