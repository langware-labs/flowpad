"""Serializers keyed by origin kind — the same aliases as ``FSOriginDriver``."""

from __future__ import annotations

from typing import Any

from flow_sdk.fs_store.origin.fs_origin import ORIGIN_KIND_ALIASES
from flow_sdk.fs_store.serializer.protocol import DataSerializer
from flow_sdk.utils.kind_registry import KindRegistry


def _build_default(registry: "KindRegistry[DataSerializer]") -> None:
    from flow_sdk.fs_store.serializer.db import DbSerializer  # lazy
    from flow_sdk.fs_store.serializer.disk import DiskSerializer  # lazy: disk imports the registry
    from flow_sdk.fs_store.serializer.hub import HubSerializer  # lazy

    registry.register(DiskSerializer())
    registry.register(DbSerializer())
    registry.register(HubSerializer())


SERIALIZERS: "KindRegistry[DataSerializer]" = KindRegistry(
    "DataSerializer", aliases=ORIGIN_KIND_ALIASES, builder=_build_default
)


def get_serializer(kind: str, info: Any = None) -> DataSerializer:
    """The serializer for ``kind``. ``info`` (a ``TypeInfo``) lets the disk
    serializer pick its legacy fallback for a type with no ``asset_spec``."""
    return SERIALIZERS.get(kind)
