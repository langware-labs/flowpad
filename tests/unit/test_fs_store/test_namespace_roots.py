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


def test_a_namespace_is_claimed_once(tmp_path):
    """The loader imports a project's folders on the FIRST miss and not again — the
    second ask is a set membership test, not another directory scan."""
    namespace_roots.remember("acme", tmp_path)
    assert namespace_roots.claim_unloaded("acme") == tmp_path
    assert namespace_roots.claim_unloaded("acme") is None


def test_an_unknown_root_is_never_claimed():
    """The map may simply not be filled yet. Claiming an unknown namespace as done
    would leave it unreadable for the life of the process."""
    assert namespace_roots.claim_unloaded("acme") is None
    assert namespace_roots.claim_unloaded("acme") is None


def test_invalidate_lets_the_folders_be_imported_again(tmp_path):
    """The map and what has been loaded from it are ONE fact; dropping the map alone
    would leave a moved project's folders permanently unreachable."""
    namespace_roots.remember("acme", tmp_path)
    namespace_roots.claim_unloaded("acme")
    namespace_roots.invalidate()
    namespace_roots.remember("acme", tmp_path)
    assert namespace_roots.claim_unloaded("acme") == tmp_path
