"""Registry-driven enumeration and placement within explicitly supplied folders."""
from __future__ import annotations

import os
from pathlib import Path

from pydantic import field_validator

from flow_sdk.assets.asset import Asset, NotAnAsset, entry_path
from flow_sdk.fs_store.identity_carrier import Absent
from flow_sdk.fs_store.placement import mount_matches
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.schema.layout import Folder


class AssetScanIssue(DataSpec):
    path: Path
    message: str


class AssetScanError(ValueError):
    def __init__(self, issues: list[AssetScanIssue]):
        self.issues = issues
        super().__init__("; ".join(f"{i.path}: {i.message}" for i in issues))


def _broken_link(path: Path) -> Path | None:
    return next((parent for parent in (path, *path.parents) if parent.is_symlink() and not parent.exists()), None)


class AssetFolder(DataSpec):
    path: Path
    project_id: str | None = None
    recursive: bool = False

    @field_validator("path")
    @classmethod
    def normalize_path(cls, value: Path) -> Path:
        lexical = Path(os.path.abspath(value.expanduser()))
        return lexical if _broken_link(lexical) is not None else entry_path(lexical)

    def _mounts(self, root: Path | None = None) -> dict[Path, tuple[bool, frozenset[str]]]:
        """Accept a scope folder, a provider container, or a family folder."""
        root = self.path if root is None else root
        mounts: dict[Path, tuple[bool, frozenset[str]]] = {root: (self.recursive, frozenset())}
        for name in SchemaRegistry.get_all_types():
            info = SchemaRegistry.get(name)
            if info is None or info.shape is None or info.keyed_by_ref:
                continue
            recursive = self.recursive or any(w.recursive for w in info.walk)
            for mount in info.scan_mounts:
                parts = Path(mount).parts
                # Find how much of the declared mount is already in the root.
                consumed = 0
                for count in range(len(parts), 0, -1):
                    if mount_matches(root.parts, parts[:count]):
                        consumed = count
                        break
                tail = Path(*parts[consumed:])
                # Retain the literal prefix even when a broken link makes a
                # wildcard match impossible; it still requires a diagnostic.
                prefix = root
                for part in tail.parts:
                    if any(char in part for char in "*?["):
                        break
                    prefix /= part
                candidates = root.glob(str(tail)) if any(char in str(tail) for char in "*?[") else (root / tail,)
                if _broken_link(prefix) is not None:
                    candidates = (prefix,)
                for candidate in candidates:
                    previous_recursive, previous_types = mounts.get(candidate, (False, frozenset()))
                    mounts[candidate] = (previous_recursive or recursive, previous_types | {str(info.type_name)})
        return mounts

    def assets(self) -> list[Asset]:
        """List distinct occurrences; malformed candidates are explicit errors.

        Optional missing roots are empty. Ordinary unclaimed files are ignored;
        a malformed file which a registered type claims is never silently lost.
        """
        found: dict[Path, Asset] = {}
        issues: list[AssetScanIssue] = []
        collected: dict[Path, Asset | None] = {}
        failed: set[Path] = set()
        scanned: set[tuple[Path, bool, frozenset[str]]] = set()
        expanded_roots: set[Path] = set()

        def issue(path: Path, message: str) -> None:
            if path not in failed:
                issues.append(AssetScanIssue(path=path, message=message))
                failed.add(path)

        def collect(candidate: Path, allowed: frozenset[str] = frozenset()) -> Asset | None:
            candidate = entry_path(candidate)
            if candidate in collected:
                asset = collected[candidate]
            else:
                try:
                    asset = Asset.from_path(candidate, project_id=self.project_id)
                except NotAnAsset:
                    asset = None
                    # A remaining carrier in a declared folder is evidence of
                    # an incomplete asset, unlike an ordinary empty directory.
                    if candidate.is_dir():
                        for name in SchemaRegistry.get_all_types():
                            info = SchemaRegistry.get(name)
                            if info is None or not isinstance(info.shape, Folder) or not info.shape.main:
                                continue
                            body = candidate / info.shape.main
                            if body.exists() or name not in SchemaRegistry.main_file_owners(body):
                                continue
                            carrier = info.carrier.locate(info.layout_of(candidate))
                            if carrier == body:
                                continue
                            try:
                                has_identity = not isinstance(info.carrier.read(carrier), Absent)
                            except (OSError, ValueError) as error:
                                issue(candidate, str(error))
                                break
                            if has_identity:
                                issue(candidate, f"Missing asset main document: {info.shape.main}")
                                break
                except (OSError, ValueError) as error:
                    issue(candidate, str(error))
                    asset = None
                collected[candidate] = asset
            if asset is not None and (not allowed or asset.typeid.type in allowed):
                found.setdefault(asset.path, asset)
            return asset

        def walk(directory: Path, recursive: bool, ancestors: frozenset[Path], allowed: frozenset[str] = frozenset()) -> None:
            resolved = directory.resolve()
            if resolved in ancestors:
                return
            chain = ancestors | {resolved}
            try:
                entries = sorted(directory.iterdir())
            except OSError as error:
                issue(directory, str(error))
                return
            for child in entries:
                if child.name.startswith("."):
                    continue
                asset = collect(child, allowed)
                if asset is not None and isinstance(asset.info.shape, Folder):
                    scan_mounts(asset.path, chain)
                elif recursive and child.is_dir() and child not in failed:
                    walk(child, recursive, chain, allowed)

        def scan_mounts(root: Path, ancestors: frozenset[Path]) -> None:
            if root in expanded_roots:
                return
            expanded_roots.add(root)
            for mount, (recursive, types) in self._mounts(root).items():
                key = (mount, recursive, types)
                if key in scanned:
                    continue
                scanned.add(key)
                if not mount.exists():
                    broken = _broken_link(mount)
                    if broken is not None:
                        issue(broken, "Broken asset folder link")
                    continue
                asset = collect(mount)
                if mount in failed or not mount.is_dir():
                    continue
                if asset is not None and isinstance(asset.info.shape, Folder):
                    # A declared mount can be inside another asset (e.g. a
                    # skill's *.js workflow mount). Only its declared types
                    # are independent assets; its README remains support.
                    child_types = types - {str(asset.typeid.type)}
                    if child_types:
                        # Caller recursion must not widen a provider's own
                        # direct-child declaration into its support folders.
                        child_recursive = any(any(w.recursive for w in SchemaRegistry.get(name).walk) for name in child_types)
                        walk(mount, child_recursive, ancestors, child_types)
                    scan_mounts(asset.path, ancestors)
                    continue
                walk(mount, recursive, ancestors)

        if not self.path.exists():
            broken = _broken_link(self.path)
            if broken is not None:
                raise AssetScanError([AssetScanIssue(path=broken, message="Broken asset folder link")])
            return []
        if not self.path.is_dir():
            collect(self.path)
        else:
            scan_mounts(self.path, frozenset())
        if issues:
            raise AssetScanError(issues)
        return [found[path] for path in sorted(found)]

    def destination_for(self, asset: Asset) -> Path:
        """Place by the folder's declared layout; no user/project lookup."""
        info = asset.info
        matches = []
        for mount in info.scan_mounts:
            parts = Path(mount).parts
            for count in range(len(parts), 0, -1):
                if mount_matches(self.path.parts, parts[:count]):
                    matches.append(self.path.joinpath(*parts[count:]))
                    break
        unique = set(matches)
        if len(unique) == 1:
            folder = unique.pop()
        elif len(unique) > 1:
            raise ValueError(f"Ambiguous destination folder for {asset.typeid.type}: {self.path}")
        else:
            # A scope root with more than one harness destination needs its
            # caller to choose a provider folder explicitly.
            mounts = info.scan_mounts
            if len(mounts) != 1 or "*" in mounts[0]:
                raise ValueError(f"Choose a family/provider destination for {asset.typeid.type}")
            folder = self.path / mounts[0]
        if any(char in str(folder) for char in "*?["):
            raise ValueError(f"Choose a concrete destination folder for {asset.typeid.type}")
        return folder if info.singleton else folder / asset.path.name


def collect_assets(folders: list[AssetFolder]) -> list[Asset]:
    """Deduplicate overlapping scans by entry path, retaining separate copies."""
    found: dict[Path, Asset] = {}
    for folder in folders:
        for asset in folder.assets():
            previous = found.get(asset.path)
            if previous is None or (previous.project_id is None and asset.project_id is not None):
                found[asset.path] = asset
    return [found[path] for path in sorted(found)]
