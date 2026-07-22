"""Shared dot-taxonomy grammar — Python side of the cross-language contract.

The ``grammar`` section of tests/fixtures/flow_event_contract.json is ALSO
parsed by ui/tests/unit/topic-grammar.test.ts — the two suites pin one
normalize/pattern/prefix semantics. Change the fixture only with both suites
in hand.
"""
import json
from pathlib import Path

import pytest

from flow_sdk.topics.grammar import (
    is_valid_topic,
    is_valid_topic_pattern,
    normalize_topic,
    split_namespace,
    topic_ancestors,
    topic_is_within,
    topic_matches,
    topic_pattern_problem,
    topic_tree,
)

GRAMMAR = json.loads(
    (Path(__file__).parent.parent / "fixtures" / "flow_event_contract.json").read_text()
)["grammar"]


def test_normalize_contract_cases():
    for case in GRAMMAR["normalize_cases"]:
        if case["canonical"] is None:
            assert not is_valid_topic(case["raw"]), case
            with pytest.raises((ValueError, TypeError)):
                normalize_topic(case["raw"])
        else:
            assert normalize_topic(case["raw"]) == case["canonical"], case
            assert is_valid_topic(case["raw"]), case


def test_pattern_contract_cases():
    for case in GRAMMAR["pattern_cases"]:
        assert is_valid_topic_pattern(case["pattern"]) is case["valid"], case
        problem = topic_pattern_problem(case["pattern"])
        assert (problem is None) is case["valid"], case


def test_within_contract_cases():
    for case in GRAMMAR["within_cases"]:
        assert topic_is_within(case["topic"], case["prefix"]) is case["within"], case


def test_namespace_contract_cases():
    for case in GRAMMAR["namespace_cases"]:
        assert split_namespace(case["topic"]) == (case["namespace"], case["rest"]), case


def test_within_never_raises_on_untrusted_input():
    # The lenient prefix matcher is called on config-supplied strings
    # (capability kinds) — it must never raise, matching the historical
    # capability_kind_matches contract.
    assert topic_is_within("My Weird Server.mcp.claude_code", "my weird server")
    assert not topic_is_within("", "x")


def test_ancestors():
    assert topic_ancestors("a.b.c") == ["a", "a.b"]
    assert topic_ancestors("a.b.c", include_self=True) == ["a", "a.b", "a.b.c"]
    assert topic_ancestors("root") == []


def test_glob_vs_prefix_semantics_diverge():
    # Glob: `flow` does NOT match `flow.done` (no partial-tree matching
    # without `*`); prefix containment says flow.done IS within flow.
    assert not topic_matches("flow", "flow.done")
    assert topic_is_within("flow.done", "flow")


def test_topic_tree_derivation():
    tree = topic_tree(["flow.step.done", "flow.done", "entity.created"])
    assert tree[""] == ["entity", "flow"]
    assert tree["flow"] == ["flow.done", "flow.step"]
    assert tree["flow.step"] == ["flow.step.done"]
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
