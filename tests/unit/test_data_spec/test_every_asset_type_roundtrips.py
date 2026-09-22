"""Every registered asset type survives the filesystem — all 20, not 3.

``assert_roundtrip`` fills every field of a class, writes it, reads it back and
demands equality. It ran for **three** real types (`Agent`, `SubAgent`,
`Dataset`); its own docstring said "real types join the parametrize list as
they migrate", and none had. Seventeen types had no round-trip cover at all,
which is why a writer change could not be checked — only hoped about.

The list is DISCOVERED from the registry, so a new asset type is covered the
day it is registered rather than the day someone remembers this file.

Two tables carry what the generic sampler cannot know:

* ``VALID`` — a value for a field with a CROSS-FIELD rule. The sampler invents
  each field independently, so it writes an agent attempt that also carries
  commands, or a poll interval of 7 seconds. Those are the validators working;
  the sampler is what is wrong, so it is told the answer.
* ``DERIVED`` — a field that IS written but does not come back equal, each with
  the reason. This is the interesting table: it is the list of places where
  what you read is not what you wrote. It is deliberately not the same thing as
  "not stored" — a derived field still has to be written for the document to
  exist at all.
"""
from __future__ import annotations

import importlib
import pkgutil
from pathlib import Path

import pytest

# Imported for its side effect: it fills the shared tables for the three types
# that already had a hand-written round-trip test, and this file defers to them.
import tests.unit.test_data_spec.test_asset_roundtrip  # noqa: F401
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from tests.unit.test_data_spec._roundtrip import (
    NOT_COMPARED,
    NOT_ON_DISK,
    OVERRIDES,
    assert_roundtrip,
    populate,
)

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


def _import_every_entity() -> None:
    """A partial import gives a partial registry — and a wrong answer."""
    import flow_sdk.builtin as builtin

    for module in pkgutil.walk_packages(builtin.__path__, builtin.__name__ + "."):
        try:
            importlib.import_module(module.name)
        except Exception:  # noqa: BLE001 — a module that cannot import registers nothing
            pass


#: Values for fields whose rule spans several fields. Keyed by type name.
VALID: dict[str, dict] = {
    # an attempt is tagged: an `agent` attempt may not also carry `commands`
    "compute_op": {"attempts": []},
    # a source has ONE credential lifetime, not four at once; `reflect` is closed
    "data_driver": {"auth": None, "reflect": ["record"], "manifest_schema": 1},
    # a poll interval below 60s is refused
    "data_source": {"poll_interval_seconds": 300},
    # `location_type` is a closed enum, and entity-only (not in the spec)
    "micro_app": {"location_type": "Asset"},
    # only a publishable type may appear in an entry; the schema is THIS build's
    "project_manifest": {"entries": [], "manifest_schema": 1},
    # a timestamp is normalised on read, so it has to be one going in
    "source_item": {"occurred_at": "2026-01-02T03:04:05+00:00"},
    # `value_store` is env|vault, `lm_provider` is a closed set, and an
    # lm_provider credential must live in the vault rather than the environment
    "secret_pack": {
        "value_store": "vault",
        "lm_provider": "anthropic",
        "manifest_schema": 2,
        # each environment carries its own `value_store`, closed the same way
        "environments": {},
    },
}

#: Fields the disk deliberately does not give back, and why. Each entry is a
#: statement about the FORMAT, not a test that was too hard to write.
DERIVED: dict[str, dict[str, str]] = {
    "claude_md": {"name": "a fixed-name file: the name IS the filename (CLAUDE)"},
    "dataset": {"name": "derived from `title`"},
    "markdown": {"name": "derived from `title`"},
    "spec": {"name": "derived from `title`"},
    "prompt": {"group_id": "DB-side grouping; the .md carries no such key"},
    "task": {"name": "derived from `title`", "origin": "normalised on read — where an asset came from is not part of the asset"},
    # A `flat` manifest merges the header ONTO the free payload, so on read the
    # two are indistinguishable and the payload comes back as payload ∪ header.
    # Lossy BY CONSTRUCTION, and the same before `FreeForm` replaced the marker.
    "agent_trace": {"trace": "flat manifest: header and payload share one document"},
    "asset_cleanup_report": {"report": "flat manifest: header and payload share one document"},
    "usage_report": {"report": "flat manifest: header and payload share one document"},
}


def _asset_types() -> list[tuple[str, type]]:
    _import_every_entity()
    found = []
    for name in sorted(SchemaRegistry.get_all_types()):
        info = SchemaRegistry.get(name)
        if getattr(info, "asset_spec", None) is None or not getattr(info, "entity_cls", None):
            continue
        if info.entity_cls.__module__.startswith("tests."):
            continue      # a fixture type another test registered, not a shipped asset
        found.append((name, info.entity_cls))
    return found


TYPES = _asset_types()


def _prepare(name: str, entity: type) -> None:
    """Teach the shared harness this type's on-disk field set."""
    info = SchemaRegistry.get(name)
    derived = set(DERIVED.get(name, {}))
    # On disk a type carries what its SPEC declares; the rest is DB plumbing.
    generic = set(entity.model_fields) - set(info.asset_spec.model_fields) - {"id", "name"}
    # A type with a hand-written round-trip test knows its own answer; don't clobber it.
    NOT_ON_DISK.setdefault(entity, generic)
    if not info.carrier.writable:
        # A `Derived` carrier has nowhere to put an id: the identity is a
        # function of the path, re-derived on every read. Comparing it would
        # assert the opposite of what the carrier is for.
        derived = derived | {"id"}
    NOT_COMPARED[entity] = derived
    if VALID.get(name):
        OVERRIDES[entity] = {**OVERRIDES.get(entity, {}), **VALID[name]}


def test_the_registry_has_the_asset_types_we_think_it_does():
    """A new asset type lands in this list on its own; the count is the notice."""
    assert len(TYPES) == 20, [n for n, _ in TYPES]


@pytest.mark.parametrize(("name", "entity"), TYPES, ids=[n for n, _ in TYPES])
def test_every_field_survives_the_filesystem(name: str, entity: type, tmp_path: Path) -> None:
    _prepare(name, entity)
    assert_roundtrip(entity, tmp_path)


@pytest.mark.parametrize(("name", "entity"), TYPES, ids=[n for n, _ in TYPES])
def test_saving_an_unchanged_asset_does_not_rewrite_it(name: str, entity: type, tmp_path: Path) -> None:
    """A no-op save must not touch the file.

    The indexer keys on mtime, so a save that rewrites identical bytes makes
    every asset look changed — to the indexer, to git, and to anything
    watching. This is also the cheapest possible guard on a writer change: if
    the format moves, the second write differs and the mtime moves with it.
    """
    from flow_sdk.fs_store.serializer.disk import DiskSerializer
    from tests.unit.test_data_spec._roundtrip import disk_origin

    _prepare(name, entity)
    value, origin = populate(entity), disk_origin(entity, tmp_path)
    DiskSerializer().store(value, origin)
    before = {p: p.stat().st_mtime_ns for p in sorted(tmp_path.rglob("*")) if p.is_file()}
    assert before, f"{name}: storing wrote no file at all"

    DiskSerializer().store(value, origin)
    after = {p: p.stat().st_mtime_ns for p in sorted(tmp_path.rglob("*")) if p.is_file()}
    churned = [p.name for p in before if p in after and before[p] != after[p]]
    assert not churned, f"{name}: a no-op save rewrote {churned}"
    assert set(after) == set(before), f"{name}: a second save changed the file set"
