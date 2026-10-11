"""Filesystem candidate walks and diagnostics, without index scheduling or records."""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from flow_sdk.assets.layout import File, Folder, Layout, LayoutKind
from flow_sdk.assets.placement import AGENTIC_ASSETS_DIR, mount_matches, scan_mounts
from flow_sdk.schema.data_spec import DataSpec

logger = logging.getLogger(__name__)

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


class AssetScanIssue(DataSpec):
    """One thing the scan could not read. A value that travels, so a spec.

    Was a bare ``@dataclass``: it rode inside ``AssetCatalog`` (a ``DataSpec``)
    and so made its container unable to say what it looks like.
    """

    path: Path
    message: str
    type_name: str | None = None
    #: The retired main document (``agent.md``) this folder still carries instead of its current one.
    retired: str | None = None


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


# Folder names whose markdown is a project's documentation. Project markdown is
# indexed ONLY under one of these — a README, CHANGELOG or a stray note at the
# project root or inside ``src/`` is code-adjacent text, not a document.
DOC_DIR_NAMES = frozenset({"docs", "doc"})


def is_in_doc_dir(folder: Path, root: Path | None = None) -> bool:
    """True when ``folder`` is a ``docs``/``doc`` dir or lies under one.

    Only the segments from ``root`` down count (``root`` itself included), so a
    project checked out under ``~/doc/`` doesn't make every folder in it a docs
    folder. With no ``root`` every segment of ``folder`` counts.
    """
    parts = folder.parts
    if root is not None:
        try:
            parts = (root.name, *folder.relative_to(root).parts)
        except ValueError:
            pass
    return any(part.lower() in DOC_DIR_NAMES for part in parts)


def is_appledouble(name: str) -> bool:
    return name.startswith("._")


def first_seen(seen: set[str], path: Path, *, resolve: bool = False) -> bool:
    key = str(path.resolve()) if resolve else os.path.normcase(str(path))
    if key in seen:
        return False
    seen.add(key)
    return True


def directory_candidates(mount: Path, shape: File | Folder, *, recursive: bool) -> list[Path]:
    """The entries a scan considers under *mount*.

    Listed through the extended-length form (a no-op off Windows): a shipped asset nested deep inside the
    install (the smart-navigator dataset's nested data_specs did) passes Windows' 260-char MAX_PATH, and ``listdir``
    fails there although ``is_dir`` succeeds. A folder that still cannot be read is skipped, not raised:
    one unreadable folder used to abort the whole system-assets index, so no data driver loaded at all.
    """
    from flow_sdk.assets.materialize import extended_length_path  # noqa: PLC0415

    if not mount.is_dir():
        return []
    try:
        if recursive:
            pattern = f"*{shape.ext}" if isinstance(shape, File) else "*"
            return sorted(mount.rglob(pattern))
        return sorted(mount / name for name in os.listdir(extended_length_path(mount)))
    except OSError as exc:
        logger.warning("asset scan: cannot read %s, skipping it: %s", mount, exc)
        return []


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
                    result.issues.append(AssetScanIssue(path=directory, message=str(error), type_name=info.type_name))
                    continue
                for entry in entries:
                    if is_appledouble(entry.name):
                        continue
                    if (not emit(entry, resolve=directory.is_symlink()) and not walk.recursive
                            and isinstance(shape, Folder) and not entry.name.startswith(".") and entry.is_dir()):
                        result.issues.append(AssetScanIssue(
                            path=entry,
                            message=f"directory in {directory.name}/ without {shape.main}",
                            type_name=info.type_name,
                        ))
    return result


def scan_repo_tree(root: Path, infos: dict[str, TypeInfo], *, types: set[str] | None = None) -> AssetScanResult:
    result = AssetScanResult()
    renamed = {old: info for info in infos.values() for old in info.retired_families}

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
            result.issues.append(AssetScanIssue(path=directory, message=str(error)))
            return
        for family in families:
            info = infos.get(family.name)
            if info is None and family.name in renamed and family.is_dir():
                now = renamed[family.name]
                result.issues.append(AssetScanIssue(
                    path=family, type_name=now.type_name,
                    message=f"{family.name}/ is a retired family name and is not read: rename it to "
                            f"{now.family}/ and each {family.name}.json in it to {now.family}.json "
                            f'(with "type": "{now.type_name}")'))
                continue
            if info is None or not family.is_dir():
                continue
            try:
                entries = [family] if info.singleton else sorted(family.iterdir())
            except OSError as error:
                result.issues.append(AssetScanIssue(path=family, message=str(error), type_name=info.type_name))
                continue
            for entry in entries:
                candidate = classify_candidate(entry, info, parent=parent,
                                               included=types is None or info.type_name in types)
                if candidate is None:
                    retired = next((name for name in info.retired_mains if (entry / name).is_file()), None)
                    if retired is not None and entry.is_dir():
                        result.issues.append(AssetScanIssue(
                            path=entry,
                            message=f"{retired} is a retired {info.type_name} document; run {info.retired_migration}",
                            type_name=info.type_name, retired=retired))
                    continue
                ported = next(((name, how) for name, how in info.retired_files if (candidate.path / name).is_file()), None)
                if ported is not None:
                    result.issues.append(AssetScanIssue(
                        candidate.path, f"{ported[0]} belongs to a retired {info.type_name} runtime — {ported[1]}",
                        info.type_name, ported[0]))
                    continue
                result.candidates.append(candidate)
                if candidate.layout.kind is LayoutKind.FOLDER:
                    scan(candidate.path, candidate.path, ancestry)
    scan(root, root, frozenset())
    return result
