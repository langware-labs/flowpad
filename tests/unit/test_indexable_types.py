"""The indexable set is DERIVED from the walker graph, not hand-listed.

``indexable_types()`` = every declared walker output ∩ types the registry can
parse from disk ∩ ``EntityType`` members. A walker + ``from_disk_fn`` enrolls a
type with no edit to a literal — which is how nine repo/harness types were
missing orphan detection for as long as the literal existed.
"""
from __future__ import annotations

import pytest

from flow_sdk.fs_store.indexer.builtin import register_default_functions
from flow_sdk.fs_store.indexer.index_function import FSIndexer, _has_dispatch
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry

pytestmark = pytest.mark.timeout(5)


@pytest.fixture(scope="module")
def derived() -> list[RecordType]:
    idx = FSIndexer(roots=[])  # the production graph, no roots — nothing is walked
    register_default_functions(idx)
    return idx.terminal_output_types()


def _walker_outputs(idx: FSIndexer) -> set[str]:
    out: set[str] = set()
    for fns in idx._functions.values():
        for _fn, outputs in fns:
            out.update(str(t) for t in (outputs or ()))
    return out


def test_every_indexed_by_default_type_is_in_the_derived_set(derived):
    names = {str(t) for t in derived}
    missing = set(SchemaRegistry.get_default_index_types()) - names
    assert not missing, missing


def test_every_walked_type_with_a_parser_is_in_the_derived_set(derived):
    """The nine types the literal never listed now get orphan detection."""
    idx = FSIndexer(roots=[])
    register_default_functions(idx)
    members = {str(t) for t in RecordType}
    expected = {
        n for n in _walker_outputs(idx)
        if n in members and (info := SchemaRegistry.get(n)) is not None and _has_dispatch(info)
    }
    assert {str(t) for t in derived} == expected
    formerly_missing = {
        "agent_trace", "data_source_spec", "graph_workflow", "helpdesk", "journey",
        "mcp", "prompt", "secret_origin", "workflow_run",
    }
    assert formerly_missing <= expected, formerly_missing - expected


def test_markdown_index_and_scaffolds_are_not_indexable(derived):
    """``markdown_index`` is discover-route only (by decision); the traversal
    scaffolds are emitted only to be walked further, never written."""
    names = {str(t) for t in derived}
    assert "markdown_index" not in names
    assert not names & {"folder", "claude_hook_source", "mcp_server_source"}
    assert "codex_project" not in names, "deprecated alias, no walker emits it"


def test_derived_set_is_registry_ordered(derived):
    """Positional slices (``?limit_types=N``) must be deterministic."""
    order = {n: i for i, n in enumerate(SchemaRegistry.get_all_types())}
    positions = [order[str(t)] for t in derived]
    assert positions == sorted(positions)
    assert len(set(derived)) == len(derived)


def test_legacy_alias_reads_the_derivation(monkeypatch):
    import flow_sdk.fs_store.indexer as pkg
    import flow_sdk.fs_store.indexer.builtin as builtin

    sentinel = [RecordType.SKILL]
    monkeypatch.setattr(builtin, "indexable_types", lambda: sentinel)
    monkeypatch.setattr(pkg, "indexable_types", lambda: sentinel)
    assert builtin.INDEXABLE_TYPES is sentinel
    assert pkg.INDEXABLE_TYPES is sentinel
    with pytest.raises(AttributeError):
        builtin.NOT_A_NAME  # noqa: B018
