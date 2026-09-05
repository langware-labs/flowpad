"""Single authoring home for per-type metadata.

Each ``schema/type_info/<type>_info.py`` module declares one (or more)
``TypeInfo`` instance at module scope — the SAME object the registry serves.
``register_all()`` imports every sibling module and registers every ``TypeInfo``
it finds into ``SchemaRegistry`` as ``declared``, with the default ``locations``. There is no separate authoring mirror: a type
declares itself ONCE, with its on-disk shape as ``shape=File(...) | Folder(...)``
and its editor as ``editor=``.

Concrete entity classes carry NO type-metadata config; they only attach
``entity_cls`` via ``Entity.__init_subclass__`` (merged in by the registry).
"""
from __future__ import annotations

import importlib
import logging
import pkgutil
from typing import Any

from flow_sdk.fs_store.schema_registry import SchemaRegistry, TypeInfo

logger = logging.getLogger(__name__)


def render_entity_frontmatter(entity: Any, fields: dict[str, Any]) -> str:
    """Render domain frontmatter; identity is stored by ``AssetCapsule``."""
    from flow_sdk.fs_store.indexer._frontmatter import _render_frontmatter  # noqa: PLC0415

    return _render_frontmatter(fields)


def declared_type_infos(module: Any) -> list[TypeInfo]:
    """Every distinct ``TypeInfo`` bound at module scope, in definition order.

    Deduped by identity: a module may re-export a sibling's declaration under a
    second name (an alias), and that is one type, not two registrations.
    """
    seen: set[int] = set()
    out: list[TypeInfo] = []
    for value in vars(module).values():
        if isinstance(value, TypeInfo) and id(value) not in seen:
            seen.add(id(value))
            out.append(value)
    return out


def register_all() -> None:
    """Import every ``*_info`` sibling module and register its ``TypeInfo``s.

    Each module is registered independently: a broken one (a stale
    ``*_type_info.py`` from a partial upgrade) is logged and SKIPPED, so one
    missing type never keeps the server from booting.
    """
    import flow_sdk.schema.type_info as pkg

    for mod in pkgutil.iter_modules(pkg.__path__):
        if mod.name.startswith("_"):
            continue
        try:
            module = importlib.import_module(f"{__name__}.{mod.name}")
            for info in declared_type_infos(module):
                if not info.locations:
                    info.locations = ["index"]
                SchemaRegistry.register(info, declared=True)
        except Exception:  # noqa: BLE001 — one bad module must not wedge the registry
            logger.warning(
                "register_all: skipping type_info module %r (failed to load/register) — "
                "that type will be unavailable, but the registry stays usable. "
                "A stale/mismatched install is the usual cause.",
                mod.name,
                exc_info=True,
            )
    # Post-pass, once every entity class is complete: a spec/row mismatch RAISES.
    SchemaRegistry.check_asset_specs()
