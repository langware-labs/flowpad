"""Which project owns a namespace — the one map a synchronous reader may ask.

``SchemaRegistry.kind_type`` runs inside a pydantic validator while a row is being
hydrated. It cannot await, so it cannot ask the database which project declared
``--acme--``. This map is how the answer gets to it, filled by the paths that CAN
await (the manifest's post-sync hook, project creation, the boot sweep).
"""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.fs_store.operations import namespace_roots

pytestmark = pytest.mark.timeout(5)  # do not increase without approval


@pytest.fixture(autouse=True)
def _clean_map():
    namespace_roots.invalidate()
    yield
    namespace_roots.invalidate()


def test_an_unbuilt_map_answers_none_rather_than_raising(tmp_path):
    """A validator asks this while restoring a row. "I don't know yet" must be a
    value, not an exception — and it must not be cached as "no such namespace"."""
    assert namespace_roots.root_for("acme") is None
    namespace_roots.remember("acme", tmp_path)
    assert namespace_roots.root_for("acme") == tmp_path


def test_ours_is_never_a_lookup(tmp_path):
    """The bare namespace is ours and is served by the SDK's own loader; asking this
    map for it would be asking which project owns the flow ontology."""
    namespace_roots.remember("", tmp_path)
    assert namespace_roots.root_for("") is None


def test_a_second_claim_on_one_namespace_keeps_the_first(tmp_path, caplog):
    """Two projects may legitimately claim one name — a namespace is an unvalidated
    claim — but only one folder can answer here. Flipping between them on every
    re-index would make a kind resolve differently depending on scan order."""
    first, second = tmp_path / "a", tmp_path / "b"
    namespace_roots.remember("acme", first)
    namespace_roots.remember("acme", second)
    assert namespace_roots.root_for("acme") == first
    assert "claimed by" in caplog.text


def test_remembering_the_same_root_twice_is_quiet(tmp_path, caplog):
    namespace_roots.remember("acme", tmp_path)
    namespace_roots.remember("acme", Path(str(tmp_path)))
    assert "claimed by" not in caplog.text


def test_invalidate_lets_the_folders_be_imported_again():
    """The map and the "already imported" memo are one fact; dropping one without the
    other would leave a namespace permanently unloadable after a project moved."""
    from flow_sdk.ingest import driver_registry

    driver_registry._NS_LOADED.add("acme")
    namespace_roots.invalidate()
    assert "acme" not in driver_registry._NS_LOADED
