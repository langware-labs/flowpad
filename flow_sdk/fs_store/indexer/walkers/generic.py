"""The ONE generic walker — driven by a type's ``Walk`` declaration.

A type that declares ``walk=Walk(...)`` (``flow_sdk.schema.layout``) is scanned
by ``layout_walker(info)`` instead of a hand-written function: for each root
node the walker resolves the type's mounts, looks at the entries there, asks
the type's SHAPE whether each entry is an instance (``shape.locate(entry,
verify=True)``) and yields one ``FSRef`` per hit.

What used to be re-implemented per walker — the ``seen`` set keyed on the
resolved path, sorted iteration, the AppleDouble (``._foo``) skip, the
"already owned by the harness mount" guard of the folder-wide walks — lives
here once. Near-misses are COLLECTED, never silently dropped: a directory in a
family mount that is not the shape (a ``skills/<x>/`` with no ``SKILL.md``) is
logged as a ``ScanIssue`` so the scan report can show it.

Mount vocabulary (``Walk.mounts``):

* ``()`` — derive from placement (``placement.scan_mounts``): every harness
  prefix + family for a fan-out class, the one canonical mount otherwise.
* ``"a/b"`` — a root-relative directory. A ``*`` component is a glob
  (``.claude/skills/*`` — the skill-bundled workflow scripts).
* ``"."`` (``SELF``) — the "anywhere" walk over FOLDER scaffold nodes. A
  Folder-shaped type asks whether the node ITSELF is the asset (every walked
  folder is a FOLDER node, the project root included); a File-shaped type
  looks at the node's direct children. Entries sitting inside a mount one of
  the type's OTHER walks covers are skipped — that walk already owns them
  (a ``.claude/skills/<x>`` is the harness walk's, not the folder walk's).
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerFunc, IndexerOptions
from flow_sdk.fs_store.indexer.index_log import (
    UNCLASSIFIED_IN_FAMILY_DIR,
    ScanIssue,
    append_scan_issue,
)
from flow_sdk.fs_store.placement import scan_mounts
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.schema.layout import File, Folder, LayoutKind, Walk

if TYPE_CHECKING:
    from flow_sdk.fs_store.schema_registry import TypeInfo

logger = logging.getLogger(__name__)

SELF = "."

_HITS = frozenset({LayoutKind.FOLDER, LayoutKind.FILE, LayoutKind.MAIN_FILE})


def walks_of(info: "TypeInfo") -> tuple[Walk, ...]:
    """The type's walks as a tuple — ``walk`` may be one ``Walk`` or several
    (skill: the harness-mount walk plus the folder-wide one)."""
    walk = info.walk
    if walk is None:
        return ()
    return (walk,) if isinstance(walk, Walk) else tuple(walk)


def walk_roots(info: "TypeInfo") -> tuple[RecordType, ...]:
    """Every root node kind the type's walks hang on, first-seen order."""
    out: list[RecordType] = []
    for walk in walks_of(info):
        for root in walk.roots:
            rt = RecordType(root)
            if rt not in out:
                out.append(rt)
    return tuple(out)


def placement_mounts(info: "TypeInfo") -> tuple[str, ...]:
    """The mounts placement gives this type (``scan_mounts`` over its triple)."""
    asset_class, harness, family = info._resolved_layout
    return scan_mounts(asset_class, harness, family)


def _is_appledouble(name: str) -> bool:
    """macOS AppleDouble sidecars (``._foo.md``) share the extension of the
    file they shadow but hold a binary resource fork, never an asset."""
    return name.startswith("._")


def _under_mount(path: Path, mounts: tuple[str, ...]) -> bool:
    """True when ``path``'s parent IS one of ``mounts`` (``.claude/skills/x`` for
    the ``.claude/skills`` mount) — the entry belongs to that mount's walk.
    A glob mount names no one directory and never claims an entry here."""
    parent_parts = path.parent.parts
    for mount in mounts:
        if "*" in mount:
            continue
        parts = tuple(Path(mount).parts)
        if parts and parent_parts[-len(parts):] == parts:
            return True
    return False


def _resolve_mounts(root: Path, mounts: tuple[str, ...]) -> list[Path]:
    dirs: list[Path] = []
    for mount in mounts:
        if "*" in mount:
            dirs.extend(sorted(p for p in root.glob(mount) if p.is_dir()))
        else:
            dirs.append(root / mount)
    return dirs


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
    walks = walks_of(info)
    if not walks:
        raise ValueError(f"{info.type_name}: no walk declared")
    derived = placement_mounts(info)
    # What the folder-wide ("." ) walk must leave alone: every mount another
    # walk of this type looks in. A type with only a "." walk (spreadsheet)
    # owns nothing else and claims a file wherever it sits.
    owned = tuple(
        m
        for walk in walks
        if walk.mounts != (SELF,)
        for m in (walk.mounts or derived)
        if m != SELF
    )
    by_root: dict[RecordType, list[Walk]] = {}
    for walk in walks:
        for root in walk.roots:
            by_root.setdefault(RecordType(root), []).append(walk)

    def emit(path: Path, node: FSRef, out: list[FSRef], seen: set[str]) -> None:
        layout = shape.locate(path, verify=True)
        if layout.kind not in _HITS:
            return
        key = str(layout.ref.resolve())
        if key in seen:
            return
        seen.add(key)
        out.append(FSRef(layout.ref, record_type=record_type, parent=node))

    def walk_self(node: FSRef, out: list[FSRef], seen: set[str]) -> None:
        here = Path(node.path)
        if isinstance(shape, Folder):
            if not _under_mount(here, owned):
                emit(here, node, out, seen)
            return
        for entry in _candidates(here, shape, recursive=False):
            if _is_appledouble(entry.name) or _under_mount(entry, owned):
                continue
            emit(entry, node, out, seen)

    def walk_mount(mount: Path, node: FSRef, walk: Walk, out: list[FSRef], seen: set[str]) -> None:
        for entry in _candidates(mount, shape, recursive=walk.recursive):
            if _is_appledouble(entry.name):
                continue
            before = len(out)
            emit(entry, node, out, seen)
            if len(out) == before and not walk.recursive and isinstance(shape, Folder):
                _collect_near_miss(entry, mount)

    def _collect_near_miss(entry: Path, mount: Path) -> None:
        # A directory in a Folder type's family mount that is not the shape
        # (no main document) is a near-miss the owner should see, not a
        # silent skip. A file there (a README) or a dot-dir is not one.
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
                root = Path(node.path)
                mounts = walk.mounts or derived
                for mount in mounts:
                    if mount == SELF:
                        walk_self(node, out, seen)
                        continue
                    for mount_dir in _resolve_mounts(root, (mount,)):
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
