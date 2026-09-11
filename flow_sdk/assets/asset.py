"""Filesystem asset values: identity belongs to the file, not an index row."""
from __future__ import annotations

import os
from pathlib import Path
from typing import TYPE_CHECKING

from pydantic import PrivateAttr, computed_field, model_validator

from flow_sdk.assets.materialize import MaterializationMode, materialize_asset_sync, remove_path
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.schema.layout import File, Folder, LayoutKind

if TYPE_CHECKING:
    from flow_sdk.fs_store.schema_registry import TypeInfo
    from flow_sdk.schema.layout import Layout


class NotAnAsset(LookupError):
    """No registered filesystem asset exists at this path."""


class AssetIdentityMismatch(ValueError):
    """A saved reference no longer identifies the file it points to."""


def entry_path(path: str | Path) -> Path:
    """Normalize an entry without following its final symlink."""
    path = Path(os.path.abspath(Path(path).expanduser()))
    return path.parent.resolve() / path.name


class Asset(DataSpec):
    path: Path
    project_id: str | None = None
    _identity: TypeId = PrivateAttr()
    _info: object = PrivateAttr()
    _layout: object = PrivateAttr()

    @model_validator(mode="after")
    def resolve_file(self) -> Asset:
        from flow_sdk.fs_store.schema_registry import SchemaRegistry

        # Classify before resolving parent links: a main document beneath a
        # linked folder must select that folder occurrence, not its source.
        path = Path(os.path.abspath(self.path.expanduser()))
        if not path.exists():
            raise FileNotFoundError(path)
        type_name = SchemaRegistry.type_for(path)
        info = SchemaRegistry.get(type_name) if type_name else None
        if info is None or info.keyed_by_ref:
            raise NotAnAsset(f"No path-addressable asset at {path}")
        layout = info.layout_of(path, verify=True)
        if layout.kind is LayoutKind.NONE or info.claims(path) is not None:
            raise NotAnAsset(f"Invalid {type_name} layout at {path}")
        root = entry_path(layout.root)
        layout = info.layout_of(root, verify=True)
        object.__setattr__(self, "path", root)
        self._info = info
        self._layout = layout
        self._identity = TypeId(type=type_name, id=info.read_identity(layout))
        return self

    @model_validator(mode="wrap")
    @classmethod
    def validate_serialized_identity(cls, value, handler):
        # Serialized values carry the computed ID. It is an assertion about
        # today's file, never an alternative source of identity.
        if isinstance(value, dict) and "typeid" in value:
            fields = dict(value)
            expected = fields.pop("typeid")
            asset = handler(fields)
            if str(asset.typeid) != str(expected):
                raise AssetIdentityMismatch(f"Serialized asset identity does not match {asset.path}")
            return asset
        return handler(value)

    @computed_field
    @property
    def typeid(self) -> TypeId:
        return self._identity

    @property
    def info(self) -> TypeInfo:
        return self._info

    @property
    def layout(self) -> Layout:
        return self._layout

    @property
    def resolved_path(self) -> Path:
        return self.path.resolve()

    @property
    def name(self) -> str:
        return self.path.name if isinstance(self.info.shape, Folder) else self.path.stem

    @classmethod
    def from_path(cls, path: str | Path, *, project_id: str | None = None) -> Asset:
        return cls(path=Path(path), project_id=project_id)

    @classmethod
    def from_typeid(cls, typeid: TypeId | str) -> Asset:
        from flow_sdk.api.api_types.identifier import is_valid_entity_id
        from flow_sdk.fs_store.fs_record import FSRecord

        ref = typeid if isinstance(typeid, TypeId) else TypeId(typeid)
        if not is_valid_entity_id(ref.id):
            raise ValueError("Asset identity must be UUID v4 or v5")
        record = FSRecord.load(ref.type, ref.id)
        if not record.asset_path:
            raise NotAnAsset(f"Filesystem record {ref} has no asset path")
        asset = cls.from_path(record.asset_path)
        if asset.typeid != ref:
            raise AssetIdentityMismatch(f"{ref} points to {asset.typeid} at {asset.path}")
        return asset

    @classmethod
    def containing(cls, path: str | Path, *, project_id: str | None = None) -> Asset | None:
        """Resolve declared nested assets, otherwise the nearest owning folder."""
        from flow_sdk.fs_store.placement import mount_matches
        from flow_sdk.fs_store.schema_registry import SchemaRegistry

        p = Path(os.path.abspath(Path(path).expanduser()))
        if not p.exists():
            return None
        if p.is_file():
            type_name = SchemaRegistry.type_for(p, placed_only=True)
            info = SchemaRegistry.get(type_name) if type_name else None
            if info is not None and isinstance(info.shape, File) and any(
                mount_matches(p.parent.parts, Path(mount).parts) for mount in info.scan_mounts
            ):
                # Explicit nested file mounts (e.g. a skill's workflow.js)
                # identify independent assets. Extension-only matches inside
                # references/scripts still belong to the surrounding folder.
                return cls.from_path(p, project_id=project_id)
        for candidate in (p, *p.parents):
            if not candidate.is_dir():
                continue
            try:
                asset = cls.from_path(candidate, project_id=project_id)
            except NotAnAsset:
                continue
            if isinstance(asset.info.shape, Folder):
                return asset
        try:
            return cls.from_path(p, project_id=project_id)
        except NotAnAsset:
            return None

    def install(self, path: str | Path, *, mode: MaterializationMode = MaterializationMode.COPY, overwrite: bool = False) -> Asset:
        """Install at an exact destination, preserving identity and source bytes."""
        destination = entry_path(path)
        if destination == self.path:
            raise ValueError("Source and destination asset trees overlap")
        current = self.from_path(self.path)
        if current.typeid != self.typeid:
            raise AssetIdentityMismatch(f"Asset source identity changed at {self.path}")
        mode = MaterializationMode(mode)
        from flow_sdk.fs_store.schema_registry import SchemaRegistry

        probe = destination / self.info.shape.main if isinstance(self.info.shape, Folder) and self.info.shape.main else destination
        if SchemaRegistry.type_for(probe) != self.typeid.type:
            raise AssetIdentityMismatch("Destination cannot preserve the source asset type")

        def prepare(staged: Path) -> None:
            if mode is MaterializationMode.COPY and self.info.carrier.writable:
                self.info.stamp_id(staged, self.typeid.id)
            # Temporary staging adds path segments outside a type's declared
            # placement. Validate its known source layout/carrier there; the
            # actual destination's classification was checked above.
            layout = self.info.layout_of(staged, verify=True)
            if layout.kind is LayoutKind.NONE or self.info.read_identity(layout) != self.typeid.id:
                raise AssetIdentityMismatch("Destination cannot preserve the source asset type and identity")

        destination = materialize_asset_sync(self.path, destination, mode=mode, overwrite=overwrite, prepare=prepare)
        return self.from_path(destination)

    def remove(self) -> None:
        """Remove this occurrence. A symlink's target is never removed."""
        remove_path(self.path)
