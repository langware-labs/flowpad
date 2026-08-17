"""AGENT and SUBAGENT are two different things and must read as two.

Scoped to this one pair on purpose: icon uniqueness is NOT an invariant this
codebase holds (10 glyphs are shared across 23 types today), so a registry-wide
no-collision test would need a 10-entry allowlist on day one.
"""
from flow_sdk.fs_store.schema_registry import SchemaRegistry


def test_agent_and_subagent_are_distinct_in_the_registry():
    assert "agent" in SchemaRegistry.get_all_types()
    assert "subagent" in SchemaRegistry.get_all_types()
    # Both shared icon="Bot" once, so every registry-driven surface — rail,
    # tabs, breadcrumb, navigator, graph nodes — drew the same robot for both.
    assert SchemaRegistry.get_icon("agent") != SchemaRegistry.get_icon("subagent")
    assert SchemaRegistry.get_display_name("agent") != SchemaRegistry.get_display_name("subagent")
