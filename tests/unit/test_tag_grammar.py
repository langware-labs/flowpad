"""Shared dot-taxonomy grammar — Python side of the cross-language contract.

The ``grammar`` section of tests/fixtures/flow_event_contract.json is ALSO
parsed by ui/tests/unit/tag-grammar.test.ts — the two suites pin one
normalize/pattern/prefix semantics. Change the fixture only with both suites
in hand.
"""
import json
from pathlib import Path

import pytest

from flow_sdk.tags.grammar import (
    is_valid_tag,
    is_valid_tag_pattern,
    normalize_tag,
    join_namespace,
    split_namespace,
    tag_ancestors,
    tag_is_within,
    tag_matches,
    tag_pattern_problem,
    tag_tree,
)

GRAMMAR = json.loads(
    (Path(__file__).parent.parent / "fixtures" / "flow_event_contract.json").read_text()
)["grammar"]


def test_normalize_contract_cases():
    for case in GRAMMAR["normalize_cases"]:
        if case["canonical"] is None:
            assert not is_valid_tag(case["raw"]), case
            with pytest.raises((ValueError, TypeError)):
                normalize_tag(case["raw"])
        else:
            assert normalize_tag(case["raw"]) == case["canonical"], case
            assert is_valid_tag(case["raw"]), case


def test_pattern_contract_cases():
    for case in GRAMMAR["pattern_cases"]:
        assert is_valid_tag_pattern(case["pattern"]) is case["valid"], case
        problem = tag_pattern_problem(case["pattern"])
        assert (problem is None) is case["valid"], case


def test_within_contract_cases():
    for case in GRAMMAR["within_cases"]:
        assert tag_is_within(case["tag"], case["prefix"]) is case["within"], case


def test_namespace_contract_cases():
    for case in GRAMMAR["namespace_cases"]:
        assert split_namespace(case["tag"]) == (case["namespace"], case["rest"]), case


def test_within_never_raises_on_untrusted_input():
    # The lenient prefix matcher is called on config-supplied strings
    # (capability kinds) — it must never raise, matching the historical
    # capability_kind_matches contract.
    assert tag_is_within("My Weird Server.mcp.claude_code", "my weird server")
    assert not tag_is_within("", "x")


def test_ancestors():
    assert tag_ancestors("a.b.c") == ["a", "a.b"]
    assert tag_ancestors("a.b.c", include_self=True) == ["a", "a.b", "a.b.c"]
    assert tag_ancestors("root") == []


def test_glob_vs_prefix_semantics_diverge():
    # Glob: `flow` does NOT match `graph_workflow.done` (no partial-tree matching
    # without `*`); prefix containment says graph_workflow.done IS within graph_workflow.
    assert not tag_matches("graph_workflow", "graph_workflow.done")
    assert tag_is_within("graph_workflow.done", "graph_workflow")


def test_tag_tree_derivation():
    tree = tag_tree(["graph_workflow.step.done", "graph_workflow.done", "entity.created"])
    assert tree[""] == ["entity", "graph_workflow"]
    assert tree["graph_workflow"] == ["graph_workflow.done", "graph_workflow.step"]
    assert tree["graph_workflow.step"] == ["graph_workflow.step.done"]
    assert tree["entity"] == ["entity.created"]


def test_kind_shim_behavior_preserved():
    # worldview/ontology.py is now a shim — historical raising behavior and
    # results must be identical.
    from flow_sdk.worldview.ontology import kind_ancestors, kind_matches, normalize_kind

    assert normalize_kind("  Application.Web ") == "application.web"
    with pytest.raises(ValueError):
        normalize_kind("not a kind!")
    assert kind_matches("workload", "workload.service.http")
    assert not kind_matches("workload.service", "workload")
    assert kind_ancestors("a.b.c", include_self=True) == ["a", "a.b", "a.b.c"]


def test_capability_matcher_behavior_preserved():
    from flow_sdk.core.capabilities.models import capability_kind_matches

    assert capability_kind_matches("harness", "harness.claude.cli")
    assert capability_kind_matches("gmail", "gmail.mcp.claude_code")
    assert not capability_kind_matches("harness.claude", "harness.codex.cli")
    # Never raises on untrusted strings (historical contract).
    assert not capability_kind_matches("x", "Not A Valid Kind At All")


def test_join_namespace_is_the_inverse_of_split() -> None:
    """The marker format has exactly one owner. It used to be written by hand
    wherever a namespaced kind was minted, so only the READ side was covered by
    the Python/TS parity contract."""
    for namespace, rest in (("acme", "orders.created"), ("acme", "ingest.message.slack")):
        joined = join_namespace(namespace, rest)
        assert joined == f"--{namespace}--.{rest}"
        assert split_namespace(joined) == (namespace, rest)
        assert normalize_tag(joined) == joined      # a namespaced kind is a legal tag


def test_the_system_namespace_is_never_written() -> None:
    """Ours is the default and it is silent: no marker, at all."""
    assert join_namespace("", "orders.created") == "orders.created"
    assert join_namespace(None, "orders.created") == "orders.created"


def test_a_namespace_the_marker_cannot_hold_fails_where_it_is_built() -> None:
    """Rather than producing a tag `normalize_tag` rejects somewhere later."""
    with pytest.raises(ValueError, match="not a usable namespace"):
        join_namespace("Acme Corp", "orders.created")
