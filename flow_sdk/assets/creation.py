"""Exact-path creation, collision policy and additive filesystem scaffolds."""
from __future__ import annotations

import asyncio
import threading
from contextlib import asynccontextmanager, contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import TYPE_CHECKING

from filelock import Timeout

from flow_sdk.api.api_types.identifier import is_valid_entity_id, mint_uuid
from flow_sdk.assets.layout import Folder
from flow_sdk.capsules.atomic import capsule_lock
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.schema.types import EntityType

if TYPE_CHECKING:
    from flow_sdk.assets.asset import Asset
    from flow_sdk.fs_store.schema_registry import TypeInfo


class AssetPathCollisionError(ValueError):
    """A destination is occupied by another asset or another creator."""


_HELD_CREATIONS: ContextVar[frozenset[tuple[object, str]]] = ContextVar("asset_creations", default=frozenset())


def _owner() -> object:
    try:
        task = asyncio.current_task()
    except RuntimeError:
        task = None
    return task if task is not None else threading.get_ident()


def _carrier_identity_matches(info: TypeInfo, path: Path, entity_id: str) -> bool:
    try:
        return info.read_id(path) == entity_id
    except (OSError, ValueError):
        return False


def assert_create_target_available(info: TypeInfo, path: Path, *, entity_type: str = "asset", name: str = "", entity_id: str | None = None) -> None:
    """An empty folder or the same identity is adoptable; occupied bytes are not."""
    path = Path(path)
    carrier = info.body_path_for(path)
    collision = carrier.exists() or carrier.is_symlink()
    if not collision and isinstance(info.shape, Folder):
        folder = info.storage_root_for(path)
        if folder.is_symlink():
            collision = True
        elif folder.exists():
            if not folder.is_dir():
                collision = True
            else:
                try:
                    collision = next(folder.iterdir(), None) is not None
                except OSError:
                    collision = True
    if collision and not (entity_id and _carrier_identity_matches(info, path, entity_id)):
        raise AssetPathCollisionError(f"An {entity_type} named '{name}' already exists in this scope")


@contextmanager
def creation_reservation(info: TypeInfo, path: Path):
    """Reserve a carrier across sync/async callers without waiting or retrying.

    Reentrancy belongs to the current task (or synchronous thread), never to a
    child task merely inheriting its parent's context variables.
    """
    carrier = info.body_path_for(Path(path)).resolve(strict=False)
    key = (_owner(), str(carrier))
    held = _HELD_CREATIONS.get()
    if key in held:
        yield
        return
    # Separate from the carrier's own lock: first creation may stamp a capsule.
    lock = capsule_lock(carrier.with_name(f".{carrier.name}.asset-creation"))
    try:
        lock.acquire(blocking=False)
    except Timeout as exc:
        raise AssetPathCollisionError(f"Asset destination is being created: {path}") from exc
    token = _HELD_CREATIONS.set(held | {key})
    try:
        yield
    finally:
        _HELD_CREATIONS.reset(token)
        lock.release()


@asynccontextmanager
async def create_target_guard(info: TypeInfo, path: Path):
    """Application reservation spanning the DB write and first carrier store."""
    with creation_reservation(info, path):
        yield


def _identity(type_name: EntityType, typeid: TypeId | None) -> TypeId:
    ref = typeid or TypeId(type=type_name, id=mint_uuid())
    if ref.type != type_name or not is_valid_entity_id(ref.id):
        raise ValueError("Creation identity must match its type and be UUID v4/v5")
    return ref


def folder_slug(name: str, fallback: str) -> str:
    """Filesystem-safe folder name from an entity name."""
    return (
        "".join(c if c.isalnum() or c in "-_" else "-" for c in (name or fallback)).strip("-")
        or fallback
    )


def destination_in(folder: Path, type: EntityType | TypeInfo, name: str) -> Path:
    """Derive a contained filename inside an already selected family folder."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry, TypeInfo

    info = type if isinstance(type, TypeInfo) else SchemaRegistry.get(type)
    if info is None or info.shape is None:
        raise ValueError(f"{type} has no filesystem asset layout")
    raw = name.strip().lower()
    safe = "".join(character if character.isalnum() or character in "_-" else "_" for character in raw) or "untitled"
    base = Path(folder).expanduser().resolve()
    if info.singleton:
        target = base
    elif isinstance(info.shape, Folder):
        target = base / safe
    else:
        target = base / f"{safe}{info.shape.ext}"
    resolved = target.resolve()
    if not resolved.is_relative_to(base):
        raise ValueError(f"Derived {type} asset path escapes its scope root")
    return resolved


def create_asset(path: Path, type: EntityType, spec: DataSpec, *, typeid: TypeId | None = None, overwrite: bool = False) -> Asset:
    """Write a typed main document at an exact destination; no scope lookup."""
    import tempfile

    from flow_sdk.assets.asset import Asset, entry_path
    from flow_sdk.assets.materialize import materialize_asset_sync
    from flow_sdk.assets.serialization import render_asset, write_asset_fields
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    type_name = EntityType(type)
    info = SchemaRegistry.get(type_name)
    if info is None:
        raise ValueError(f"Unknown asset type: {type_name}")
    if not info.carrier.writable:
        raise ValueError(f"{type_name} has no writable asset identity")
    if not isinstance(spec, DataSpec):
        raise TypeError("Asset creation requires a DataSpec")
    if info.asset_spec is not None:
        spec = info.asset_spec.model_validate(spec.model_dump())
    ref = _identity(type_name, typeid)
    destination = entry_path(path)
    probe = destination / info.shape.main if isinstance(info.shape, Folder) and info.shape.main else destination
    if info.keyed_by_ref or SchemaRegistry.type_for(probe) != type_name:
        raise ValueError("Destination cannot preserve the requested asset type")
    if "id" in spec.__class__.model_fields:
        spec = spec.model_copy(update={"id": ref.id})
    rendered = render_asset(spec, info)
    if rendered is None:
        raise ValueError(f"{type_name} has no renderable main document")
    with creation_reservation(info, destination):
        if not overwrite:
            assert_create_target_available(info, destination, entity_type=type_name, name=destination.name, entity_id=ref.id)
            if info.body_path_for(destination).is_file():
                return Asset.from_path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".asset-create-", dir=destination.parent) as temporary:
            staged = Path(temporary) / destination.name
            body = info.body_path_for(staged)
            body.parent.mkdir(parents=True, exist_ok=True)
            body.write_text(rendered, encoding="utf-8")
            write_asset_fields(staged, info, spec)
            info.stamp_id(staged, ref.id)
            # Existing empty directories are explicitly adoptable.
            materialize_asset_sync(staged, destination, overwrite=overwrite or destination.exists())
        asset = Asset.from_path(destination)
        if asset.typeid != ref:
            raise ValueError("Created asset did not preserve the requested identity")
        return asset


def ensure_asset_scaffold(path: Path, typeid: TypeId, spec: DataSpec) -> Path:
    """Add only missing type-declared defaults, preserving authored files."""
    from flow_sdk.assets.asset import entry_path
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    info = SchemaRegistry.get(typeid.type)
    if info is None:
        raise ValueError(f"Unknown asset type: {typeid.type}")
    _identity(EntityType(typeid.type), typeid)
    destination = entry_path(path)
    with creation_reservation(info, destination):
        from flow_sdk.assets.identity_carrier import Foreign, Found

        observed = info.carrier.read(info.carrier.locate(info.layout_of(destination)))
        if isinstance(observed, Foreign) or (isinstance(observed, Found) and observed.id != typeid.id):
            raise AssetPathCollisionError(f"Asset identity differs at {destination}")
        if info.scaffold_fn is not None:
            info.scaffold_fn(destination, spec, typeid)
        if destination.exists():
            info.stamp_id(destination, typeid.id)
    return destination


def ensure_asset_document(path: Path, typeid: TypeId, fields: dict) -> Path:
    """Ensure the declared main document at an existing, exact asset occurrence."""
    from flow_sdk.assets.layout import LayoutKind
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    path = Path(path).absolute()
    info = SchemaRegistry.get(typeid.type)
    if info is None or info.scaffold_fn is None or info.scaffold_spec is None:
        raise ValueError('This asset type has no declared document scaffold')
    layout = info.layout_of(path)
    if layout.kind is not LayoutKind.MAIN_FILE or SchemaRegistry.type_for(path) != typeid.type:
        raise ValueError('The selected path is not the declared main document of this asset type')
    if not layout.root.is_dir():
        raise FileNotFoundError(layout.root)
    spec = info.scaffold_spec.model_validate(fields)
    ensure_asset_scaffold(layout.root, typeid, spec)
    return path
