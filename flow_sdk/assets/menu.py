"""Asset type selection and occurrence counts for catalog consumers."""
from collections import Counter

from flow_sdk.assets.catalog import AssetDescriptor
from flow_sdk.fs_store.type_id import TypeId


def menu_count_types(requested: list[str] | None = None) -> list[str]:
    """The types a menu counts: browseable AND filesystem-scannable.

    Counting is path-attributed (an asset belongs to the deepest node directory
    that contains it), so a type with no ``asset_ref`` — ``spec`` is the live
    example — cannot be counted this way and is excluded rather than reported as
    zero. ``get_default_index_types()`` is exactly the filesystem-scannable set,
    and ``browseable_by is not None`` is the registry's own "shows in the Assets
    browser" declaration, so neither list is restated here.
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    scannable = SchemaRegistry.get_default_index_types()
    wanted = [t for t in requested if t in set(scannable)] if requested else list(scannable)
    return [t for t in wanted if getattr(SchemaRegistry.get(t), "browseable_by", None) is not None]


def asset_counts(descriptors: list[AssetDescriptor], roots) -> dict[str, Counter]:
    counts = {root: Counter() for root in roots}
    for descriptor in descriptors:
        if descriptor.source_dir in counts:
            counts[descriptor.source_dir][TypeId(descriptor.typeid).type] += 1
    return counts
