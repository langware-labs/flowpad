"""The per-field filesystem round-trip harness.

For a class with a registered ``asset_spec``: build an instance with EVERY field
set to a non-default value (by annotation, recursing into nested assets),
``DiskSerializer.store`` it, ``load`` it back, and compare field by field — failing on the FIRST field
that does not survive, by name. That is the whole contract: what the class
declares is what the disk holds, and nothing else.

Generic on purpose. A hand-written per-field test asserts what its author
remembered; this asserts ``cls.model_fields``.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, get_args, get_origin

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.fs_store.origin.local_origin import LocalOrigin
from flow_sdk.fs_store.serializer.disk import DiskSerializer
from flow_sdk.fs_store.serializer.fields import asset_class as _asset_class
from flow_sdk.fs_store.serializer.fields import unwrap_annotation as _unwrap
from flow_sdk.schema.data_spec import DataSpec


def sample(name: str, annotation: Any, default: Any) -> Any:
    """One non-default value for a field, chosen from its annotation."""
    ann = _unwrap(annotation)
    asset_cls, is_list = _asset_class(annotation)
    if asset_cls is not None:
        built = populate(asset_cls)
        return [built] if is_list else built
    if ann is DataSpec or ann is type:          # a field that HOLDS a shape (SpecType)
        return DataSpec.parse({f"{name}_k": "string", f"{name}_n": ["int"]})
    if ann is str:
        return f"{name}-v"
    if ann is bool:
        return not bool(default)
    if ann is int:
        return 7 if default != 7 else 8
    if ann is float:
        return 0.5
    if ann is dict:
        return {f"{name}_key": f"{name}-v"}
    if ann is list:
        return [f"{name}-v"]
    origin = get_origin(ann)
    if origin is list:
        (inner,) = get_args(ann) or (str,)
        return [sample(name, inner, None)]
    if origin is dict:
        _, v = get_args(ann) or (str, str)
        return {f"{name}_key": sample(name, v, None)}
    if isinstance(ann, type) and hasattr(ann, "__members__"):   # an Enum
        members = list(ann.__members__.values())
        return next((m for m in members if m != default), members[0])
    if ann is Any:
        return {"free": name}
    if getattr(ann, "__name__", "") == "TypeId":
        return ann(f"skill-{mint_uuid()}")
    if ann is datetime:
        return datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
    raise TypeError(f"harness has no sample for field {name!r}: {annotation!r}")


def populate(cls: type) -> Any:
    """An instance of ``cls`` with every on-disk field non-default."""
    values: dict[str, Any] = {}
    overrides = OVERRIDES.get(cls, {})
    for name, field in cls.model_fields.items():
        if name in NOT_ON_DISK.get(cls, set()) or name == "type":
            continue
        if name in overrides:
            values[name] = overrides[name]
            continue
        if name == "id":
            values[name] = mint_uuid()
            continue
        values[name] = sample(name, field.annotation, field.default)
    return cls(**values)


def disk_origin(cls: type, root: Path) -> LocalOrigin:
    """Where a probe of ``cls`` lives under ``root`` — a file or a folder."""
    from flow_sdk.fs_store.serializer.fields import asset_info  # noqa: PLC0415

    return LocalOrigin(base=str(root), rel_path="asset" if asset_info(cls).main_layout == "folder" else "asset.md")


def assert_roundtrip(cls: type, root: Path) -> Any:
    serializer = DiskSerializer()
    """``store(origin)`` → ``load(origin)``; every declared field must come back equal."""
    original = populate(cls)
    origin = disk_origin(cls, root)
    committed = serializer.store(original, origin)
    assert committed.id == (original.id or ""), "store must return the origin carrying the committed id"
    back = serializer.load(cls, origin)
    target = serializer.root(origin)
    projections = COMPARE.get(cls, {})
    for name in cls.model_fields:
        if name in NOT_ON_DISK.get(cls, set()) or name == "type":
            continue
        want, got = getattr(original, name), getattr(back, name)
        if name in projections:
            want, got = projections[name](want), projections[name](got)
        assert got == want, f"{cls.__name__}.{name} did not survive the filesystem: wrote {want!r}, read {got!r}"
    return target


#: Fields a class carries in the DB but never on disk. Asserted ABSENT from the
#: written file — that is the negative half of the contract.
NOT_ON_DISK: dict[type, set[str]] = {}

#: Per-class values the generic sampler cannot invent (a dataset's rows, a
#: layout that must match them). A value here is what the class round-trips.
OVERRIDES: dict[type, dict[str, Any]] = {}

#: Fields compared by a projection rather than ``==`` — a written example dir
#: is named ``0001``, which re-mints the row ``id``, so rows compare without it.
COMPARE: dict[type, dict[str, Any]] = {}
