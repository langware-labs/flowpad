"""Filesystem candidate walks and diagnostics, without index scheduling or records."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from flow_sdk.assets.layout import File, Folder, Layout, LayoutKind
from flow_sdk.assets.placement import AGENTIC_ASSETS_DIR, mount_matches, scan_mounts

if TYPE_CHECKING:
    from flow_sdk.assets.asset import Asset
    from flow_sdk.fs_store.schema_registry import TypeInfo


@dataclass(frozen=True)
class AssetCandidate:
    path: Path
    type_name: str
    layout: Layout
    traversal_parent: Path | None = None
    included: bool = True
    asset: Asset | None = None


@dataclass(frozen=True)
class AssetScanIssue:
    path: Path
    message: str
    type_name: str | None = None


@dataclass
class AssetScanResult:
    candidates: list[AssetCandidate] = field(default_factory=list)
    issues: list[AssetScanIssue] = field(default_factory=list)

    @property
    def assets(self) -> list[Asset]:
        return [candidate.asset for candidate in self.candidates if candidate.asset is not None]


def classify_candidate(path: Path, info: TypeInfo, *, parent: Path | None = None,
                       included: bool = True) -> AssetCandidate | None:
    layout = info.layout_of(path, verify=True)
    if layout.kind is LayoutKind.NONE:
        return None
    return AssetCandidate(layout.root, info.type_name, layout, parent, included)


def is_appledouble(name: str) -> bool:
    return name.startswith("._")


def first_seen(seen: set[str], path: Path, *, resolve: bool = False) -> bool:
    key = str(path.resolve()) if resolve else os.path.normcase(str(path))
    if key in seen:
        return False
    seen.add(key)
    return True


def directory_candidates(mount: Path, shape: File | Folder, *, recursive: bool) -> list[Path]:
    if not mount.is_dir():
        return []
    if recursive:
        pattern = f"*{shape.ext}" if isinstance(shape, File) else "*"
        return sorted(mount.rglob(pattern))
    return sorted(mount.iterdir())


def scan_declared(info: TypeInfo, root: Path, root_type: str) -> AssetScanResult:
    result = AssetScanResult()
    seen: set[str] = set()
    shape = info.shape

    def emit(path: Path, *, resolve: bool = False) -> bool:
        candidate = classify_candidate(path, info, parent=root)
        if candidate is None:
            return False
        if first_seen(seen, candidate.path, resolve=resolve):
            result.candidates.append(candidate)
        return True

    def under_mount(path: Path) -> bool:
        return any(mount_matches(path.parent.parts, Path(mount).parts) for mount in info.scan_mounts)

    for walk in info.walk:
        if root_type not in walk.roots:
            continue
        if walk.anywhere:
            entries = [root] if isinstance(shape, Folder) else directory_candidates(root, shape, recursive=False)
            for entry in entries:
                if not is_appledouble(entry.name) and not under_mount(entry):
                    emit(entry)
            continue
        for mount in walk.mounts or scan_mounts(*info._resolved_layout):
            mounts = sorted(p for p in root.glob(mount) if p.is_dir()) if "*" in mount else [root / mount]
            for directory in mounts:
                try:
                    entries = directory_candidates(directory, shape, recursive=walk.recursive)
                except OSError as error:
                    result.issues.append(AssetScanIssue(directory, str(error), info.type_name))
                    continue
                for entry in entries:
                    if is_appledouble(entry.name):
                        continue
                    if (not emit(entry, resolve=directory.is_symlink()) and not walk.recursive
                            and isinstance(shape, Folder) and not entry.name.startswith(".") and entry.is_dir()):
                        result.issues.append(AssetScanIssue(
                            entry, f"directory in {directory.name}/ without {shape.main}", info.type_name,
                        ))
    return result


def scan_repo_tree(root: Path, infos: dict[str, TypeInfo], *, types: set[str] | None = None) -> AssetScanResult:
    result = AssetScanResult()

    def scan(container: Path, parent: Path, ancestors: frozenset[Path]) -> None:
        resolved = container.resolve()
        if resolved in ancestors:
            return
        ancestry = ancestors | {resolved}
        directory = container / AGENTIC_ASSETS_DIR
        if not directory.is_dir():
            return
        try:
            families = sorted(directory.iterdir())
        except OSError as error:
            result.issues.append(AssetScanIssue(directory, str(error)))
            return
        for family in families:
            info = infos.get(family.name)
            if info is None or not family.is_dir():
                continue
            try:
                entries = [family] if info.singleton else sorted(family.iterdir())
            except OSError as error:
                result.issues.append(AssetScanIssue(family, str(error), info.type_name))
                continue
            for entry in entries:
                candidate = classify_candidate(entry, info, parent=parent,
                                               included=types is None or info.type_name in types)
                if candidate is None:
                    continue
                result.candidates.append(candidate)
                if candidate.layout.kind is LayoutKind.FOLDER:
                    scan(candidate.path, candidate.path, ancestry)
    scan(root, root, frozenset())
    return result
