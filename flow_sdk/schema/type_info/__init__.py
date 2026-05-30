"""Single authoring home for per-type metadata.

Each ``schema/type_info/<type>_info.py`` module declares one (or more)
``TypeMetadata`` instance at module scope. ``register_all()`` imports every
sibling module and registers their ``TypeMetadata`` into ``SchemaRegistry``.

- ``TypeMetadata`` is the *declarative authoring* shape — what you write here.
- ``TypeInfo`` (schema_registry) is the *runtime registry record* it produces.
- A specific type may subclass ``TypeMetadata`` to add type-specific fields;
  the instance is attached to the resulting ``TypeInfo.metadata`` so base
  classes can read the extras. The flat ``TypeInfo`` fields remain the single
  serialized surface (no polymorphic serialization).

Concrete entity classes carry NO type-metadata config; they only attach
``entity_cls`` via ``Entity.__init_subclass__`` (merged in by the registry).
"""
from __future__ import annotations

import importlib
import pkgutil
from dataclasses import dataclass, field
from typing import Any

from flow_sdk.fs_store.schema_registry import SchemaRegistry, TypeInfo


@dataclass
class TypeMetadata:
    """Declarative per-type metadata. Subclass to add type-specific extras."""

    type: str
    icon: str | None = None
    browseable: bool = False
    creatable: bool = False
    indexed_by_default: bool = False
    api_visible: bool = False
    index_fields: list[str] = field(default_factory=list)
    main_subdir: str | None = None
    main_layout: str = "file"
    parent_type: str | None = None
    # Indexer dispatch callables (walked types only).
    from_disk_fn: Any = None
    gen_id_fn: Any = None
    asset_hash_fn: Any = None
    post_sync_fn: Any = None
    # Per-type pydantic metadata model — the FS↔DB schema (see TypeInfo.meta_model).
    meta_model: Any = None

    def to_type_info(self) -> TypeInfo:
        return TypeInfo(
            type_name=str(self.type),
            icon=self.icon,
            browseable=self.browseable,
            creatable=self.creatable,
            indexed_by_default=self.indexed_by_default,
            api_visible=self.api_visible,
            index_fields=list(self.index_fields),
            main_subdir=self.main_subdir,
            main_layout=self.main_layout,
            parent_type=self.parent_type,
            from_disk_fn=self.from_disk_fn,
            gen_id_fn=self.gen_id_fn,
            asset_hash_fn=self.asset_hash_fn,
            post_sync_fn=self.post_sync_fn,
            meta_model=self.meta_model,
            locations=["index"],
            metadata=self,
        )

    def register(self) -> None:
        SchemaRegistry.register(self.to_type_info())


def register_all() -> None:
    """Import every ``*_info`` sibling module and register its TypeMetadata."""
    import flow_sdk.schema.type_info as pkg

    for mod in pkgutil.iter_modules(pkg.__path__):
        if mod.name.startswith("_"):
            continue
        module = importlib.import_module(f"{__name__}.{mod.name}")
        for value in vars(module).values():
            if isinstance(value, TypeMetadata):
                value.register()
