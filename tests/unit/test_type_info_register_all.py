"""``register_all`` skips a module that fails to load — silently, by design
(a stale install must not wedge the registry). This test is the alarm that
design lacks: every ``TypeMetadata`` declared under ``schema/type_info`` is in
the registry afterwards, so a broken module surfaces here instead of as a
missing type at runtime.
"""
from __future__ import annotations

import importlib
import pkgutil

import pytest

import flow_sdk.schema.type_info as pkg
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.type_info import TypeMetadata, register_all
from flow_sdk.schema.types import EntityType

pytestmark = pytest.mark.timeout(5)


def _declared() -> dict[str, str]:
    """type name → declaring module, for every TypeMetadata in the package."""
    out: dict[str, str] = {}
    for mod in pkgutil.iter_modules(pkg.__path__):
        if mod.name.startswith("_"):
            continue
        module = importlib.import_module(f"{pkg.__name__}.{mod.name}")
        for value in vars(module).values():
            if isinstance(value, TypeMetadata):
                out[str(value.type)] = mod.name
    return out


def test_every_declared_type_info_is_registered():
    register_all()
    declared = _declared()
    assert declared, "no TypeMetadata found — the discovery itself is broken"
    registered = set(SchemaRegistry.get_all_types())
    missing = {t: m for t, m in declared.items() if t not in registered}
    assert not missing, f"register_all skipped: {missing}"


def test_every_entity_type_with_a_type_info_module_is_registered():
    register_all()
    registered = set(SchemaRegistry.get_all_types())
    stems = {m.name for m in pkgutil.iter_modules(pkg.__path__)}
    with_module = [t for t in EntityType if f"{t.value}_type_info" in stems]
    assert with_module, "no <type>_type_info modules found"
    missing = [t.value for t in with_module if t.value not in registered]
    assert not missing, missing
