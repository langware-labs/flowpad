"""Backward-compat shim: delegates all lookups to SchemaRegistry."""
from flow_sdk.fs_store.schema_registry import SchemaRegistry


class _FsRegistryShim:
    """Drop-in replacement for the old FS Record TypeRegistry."""

    def get(self, type_name: str):
        return SchemaRegistry.get_record_cls(type_name)

    def register(self, type_name: str, cls) -> None:
        pass  # no-op — registration via __init_subclass__ → SchemaRegistry

    def get_all_types(self) -> list[str]:
        return SchemaRegistry.get_all_record_types()

    def __contains__(self, type_name: str) -> bool:
        return SchemaRegistry.get_record_cls(type_name) is not None

    def __len__(self) -> int:
        return len(SchemaRegistry.get_all_record_types())


type_registry = _FsRegistryShim()
