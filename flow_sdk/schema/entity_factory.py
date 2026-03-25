"""Backward-compat shim: delegates all lookups to SchemaRegistry."""
from flow_sdk.fs_store.schema_registry import SchemaRegistry


class _EntityRegistryShim:
    """Drop-in replacement for the old TypeRegistry — delegates to SchemaRegistry."""

    def get(self, name: str):
        return SchemaRegistry.get_entity_cls(name)

    def register(self, type_name: str, entity=None) -> None:
        pass  # no-op — registration now via __init_subclass__ → SchemaRegistry

    def is_registered(self, type_name: str) -> bool:
        return SchemaRegistry.is_entity_type(type_name)

    def is_implemented(self, type_name: str) -> bool:
        return SchemaRegistry.is_implemented(type_name)

    def is_public(self, type_name: str) -> bool:
        return SchemaRegistry.is_public_entity(type_name)

    def get_all_types(self) -> list[str]:
        return SchemaRegistry.get_all_entity_types()

    def get_public_types(self) -> list[str]:
        return SchemaRegistry.get_public_entity_types()

    @property
    def entity_models(self) -> list:
        return SchemaRegistry.get_all_entity_classes()

    @property
    def registered_keys(self) -> list[str]:
        return SchemaRegistry.get_all_entity_types()

    def get_entry_by_name(self, name: str):
        return None  # RegistryEntry removed; use SchemaRegistry.get(name) for TypeInfo

    def __getitem__(self, name: str):
        return self.get(name)

    def __contains__(self, name: str) -> bool:
        return SchemaRegistry.is_entity_type(name)


# TypeRegistry alias retained for db_driver.py type annotation
TypeRegistry = _EntityRegistryShim

type_registry = _EntityRegistryShim()


def is_entity_type(e_type: str) -> bool:
    return SchemaRegistry.is_entity_type(e_type)
