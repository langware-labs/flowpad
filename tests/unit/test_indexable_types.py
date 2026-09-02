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


def test_every_indexed_by_default_type_is_in_the_derived_set(derived):
    names = {str(t) for t in derived}
    missing = set(SchemaRegistry.get_default_index_types()) - names
    assert not missing, missing


def test_the_types_the_literal_never_listed_are_indexable(derived):
    """The nine repo/harness types that went without orphan detection for as
    long as the set was hand-maintained. Named rather than re-derived: a test
    that recomputes the implementation's own formula agrees with any formula,
    including a broken one."""
    formerly_missing = {
        "agent_trace", "data_source_spec", "graph_workflow", "helpdesk", "journey",
        "mcp", "prompt", "secret_origin", "workflow_run",
    }
    assert formerly_missing <= {str(t) for t in derived}


def test_every_derived_type_is_parseable(derived):
    """The other half of the contract: nothing enters the set that the registry
    cannot read back from disk, or the orphan sweep would judge a type it can
    never see."""
    for t in derived:
        info = SchemaRegistry.get(str(t))
        assert info is not None and _has_dispatch(info), t


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
