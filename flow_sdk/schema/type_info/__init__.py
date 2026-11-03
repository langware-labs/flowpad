"""Single authoring home for per-type metadata.

Each ``schema/type_info/<type>_info.py`` module declares one (or more)
``TypeInfo`` instance at module scope — the SAME object the registry serves.
``register_all()`` imports every sibling module and registers every ``TypeInfo``
it finds into ``SchemaRegistry`` as ``declared``, with the default ``locations``. There is no separate authoring mirror: a type
declares itself ONCE. Spec-backed assets declare their filesystem contract on
``asset_spec``; ``TypeInfo.shape`` is its runtime projection. Custom-parser types
without a contract still declare ``shape=File(...) | Folder(...)`` here.

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
    from flow_sdk.assets.frontmatter import _render_frontmatter  # noqa: PLC0415

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


def _shipped_module_names() -> set[str] | None:
    """The ``type_info`` modules the installed flowpad release ships, or None when that is unknown
    (a source checkout or an editable install, whose metadata does not list the package files)."""
    from importlib import metadata  # noqa: PLC0415

    try:
        files = metadata.files("flowpad") or []
    except metadata.PackageNotFoundError:
        return None
    prefix = "flow_sdk/schema/type_info/"
    names = {
        str(f)[len(prefix):-3] for f in files if str(f).startswith(prefix) and str(f).endswith(".py")
    }
    return names if "__init__" in names else None


def register_all() -> None:
    """Import every ``*_info`` sibling module and register its ``TypeInfo``s.

    A module that fails fails the whole registration -- unless the installed release
    does not ship it. That is a file an upgrade left behind (``flow upgrade`` on a box
    left an older release's ``cron_event_type_info.py``, importing a type that was
    since removed); it is logged and SKIPPED, so a leftover never keeps the server
    from booting.
    """
    import flow_sdk.schema.type_info as pkg

    failures = []
    shipped: set[str] | None = None
    for mod in pkgutil.iter_modules(pkg.__path__):
        if mod.name.startswith("_"):
            continue
        try:
            module = importlib.import_module(f"{__name__}.{mod.name}")
            for info in declared_type_infos(module):
                if not info.locations:
                    info.locations = ["index"]
                SchemaRegistry.register(info, declared=True)
        except Exception as error:
            if shipped is None:
                shipped = _shipped_module_names() or set()
            if shipped and mod.name not in shipped:
                logger.warning("register_all: skipping %r, a leftover the installed release does not ship (%s)",
                               mod.name, error)
                continue
            failures.append((mod.name, error))
    if failures:
        details = "; ".join(f"{name}: {error}" for name, error in failures)
        raise RuntimeError(f"Type declaration registration failed: {details}") from failures[0][1]
