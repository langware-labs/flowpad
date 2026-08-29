"""Pure projection of a checked-out asset into the Hub wire contract."""

from __future__ import annotations

from pathlib import Path, PurePosixPath
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, JsonValue, field_validator

from flow_sdk.assets.git_origin import PortableGitOrigin
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identifier import is_valid_entity_id
from flow_sdk.fs_store.schema_registry import SchemaRegistry, TypeInfo

PORTABLE_ASSET_CONTRACT_VERSION = 1


class PortableAssetLayout(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    asset_rel_root: str
    main_ref: str


class PortableAssetProjection(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    contract_version: Literal[1] = PORTABLE_ASSET_CONTRACT_VERSION
    type: str
    id: str
    fields: dict[str, JsonValue]
    layout: PortableAssetLayout

    @field_validator("id")
    @classmethod
    def _validate_id(cls, value: str) -> str:
        if not is_valid_entity_id(value):
            raise ValueError("portable asset id must be a UUID v4 or v5")
        return value


def layout_for_origin(info: TypeInfo, origin: PortableGitOrigin) -> PortableAssetLayout:
    """Map the registered local shape to the one portable VFS layout."""
    rel = PurePosixPath(origin.rel_path)
    if rel.as_posix() == ".":
        raise ValueError("an asset origin requires a concrete file or folder path")
    if info.main_layout == "file":
        parent = rel.parent.as_posix()
        return PortableAssetLayout(asset_rel_root=parent, main_ref=rel.name)
    if info.main_layout == "folder" and info.main_file:
        return PortableAssetLayout(asset_rel_root=rel.as_posix(), main_ref=info.main_file)
    raise ValueError(f"type {info.type_name!r} has no portable asset layout")


_LOCAL_OR_RUNTIME_FIELDS = frozenset(
    {
        "id",
        "type",
        "asset_ref",
        "asset_occurrences",
        "scope",
        "project_id",
        "parent_path",
        "parent_type_id",
        "vault_root",
        "root_vfs_path",
        "fs_storage_provider",
        "fs_storage_mount_path",
        "fs_storage_path",
        "path",
        "cwd",
        "workdir",
        "installed_root",
        "additional_dirs",
        "created_at",
        "created_date",
        "created_by",
        "created_through",
        "updated_at",
        "updated_date",
        "updated_by",
        "updated_through",
        "last_active_at",
        "last_edited_at",
        "fetched_at",
        "visitor_role",
        "members",
        "remote",
        "origin",
        "expand",
        "env_vars",
        "group_id",
        "key",
        "namespace",
        "uname",
        "schema_version",
        "tab_order",
        "shared_context_entities",
        "shared_context_entity_data",
        "private_context_entities_",
        "private_context_entity_data",
        "translations",
        "metadata",
    }
)


def _portable_fields(entity: Any, entity_cls: type) -> dict[str, JsonValue]:
    excluded = set(entity_cls.fields_not_sent_to_hub()) | set(_LOCAL_OR_RUNTIME_FIELDS)
    computed = set(getattr(entity_cls, "model_computed_fields", {}))
    dumped = entity.model_dump(mode="json", exclude_none=True)
    return {
        key: value
        for key, value in dumped.items()
        if entity_cls.is_api_field(key) and key not in excluded and key not in computed
    }


def project_asset_tree(
    *,
    entity_type: str,
    expected_id: str,
    checkout_root: Path,
    origin: PortableGitOrigin,
) -> PortableAssetProjection:
    """Parse one asset from Git without writing, indexing, or touching the DB."""
    if not is_valid_entity_id(expected_id):
        raise ValueError("expected_id must be a UUID v4 or v5")
    info = SchemaRegistry.get(entity_type)
    if info is None or not info.git_publishable:
        raise ValueError(f"type {entity_type!r} is not Git-publishable")
    entity_cls = info.entity_cls or SchemaRegistry.get_entity_cls(entity_type)
    if entity_cls is None:
        # CLI/library callers can invoke the pure contract before server startup
        # has imported the entity catalog. Load the catalog through its one
        # registration module, then re-read the registry; no per-type import map.
        import flow_sdk.models.entities  # noqa: F401, PLC0415

        entity_cls = SchemaRegistry.get_entity_cls(entity_type)
    if entity_cls is None:
        raise ValueError(f"type {entity_type!r} has no registered entity model")

    root = Path(checkout_root).resolve(strict=True)
    if not root.is_dir() or not (root / ".git").exists() or (root / ".git").is_symlink():
        raise ValueError("checkout_root must be a concrete Git checkout directory")
    asset_root = root.joinpath(*PurePosixPath(origin.rel_path).parts)
    resolved_asset = asset_root.resolve(strict=True)
    if not resolved_asset.is_relative_to(root):
        raise ValueError("asset path escapes the checkout")
    if info.main_layout == "folder" and not resolved_asset.is_dir():
        raise ValueError("folder-layout asset origin must resolve to a directory")
    if info.main_layout == "file" and not resolved_asset.is_file():
        raise ValueError("file-layout asset origin must resolve to a file")

    parser_path = info.asset_ref_for(resolved_asset) if info.main_layout == "folder" else resolved_asset
    parser_ref = FSRef(parser_path, record_type=entity_type, read_only=True)
    observed_id = info.mint_entity_id(parser_ref)
    if observed_id != expected_id:
        raise ValueError("asset identity does not match the requested entity")
    records = list(info.from_disk_fn(parser_ref, expected_id))
    matching = [record for record in records if str(record.id) == expected_id and str(record.type) == entity_type]
    if len(records) != 1 or len(matching) != 1:
        raise ValueError("asset parser must return exactly one matching record")

    from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415

    entity = Entity._build_from_fs_record(matching[0], fallback_cls=entity_cls)
    return PortableAssetProjection(
        type=entity_type,
        id=expected_id,
        fields=_portable_fields(entity, entity_cls),
        layout=layout_for_origin(info, origin),
    )
