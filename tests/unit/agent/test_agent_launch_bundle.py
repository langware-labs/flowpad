"""The launch bundle: worker vocabulary, vendor extras, and cold-start resolution.

Each of these covers a bug that a real launch found, not a hypothetical.
"""
import pytest

from flow_sdk.builtin.agent import Agent, driver_key, worker_type_value
from flow_sdk.builtin.agent_registry import _shipped_agent

# ── the two worker vocabularies ───────────────────────────────────────────────
#
# An agent.md says "claude"; AgenticProcess.worker_type wants "claude_code".
# Feeding one where the other belongs is what made the first live launch fail
# pydantic validation, so both directions are pinned here.

@pytest.mark.parametrize(
    "raw,driver,worker",
    [
        ("claude", "claude", "claude_code"),
        ("claude_code", "claude", "claude_code"),
        ("codex", "codex", "codex"),
        ("copilot", "copilot", "copilot"),
        (None, "claude", "claude_code"),
        ("", "claude", "claude_code"),
    ],
)
def test_worker_vocabularies_map_both_ways(raw, driver, worker):
    assert driver_key(raw) == driver
    assert worker_type_value(raw) == worker


# ── vendor extras ─────────────────────────────────────────────────────────────

def test_cli_options_reach_the_bundle():
    """A vendor key the schema doesn't enumerate still has to arrive.

    `chrome` is Claude-only and has no Agent field; the chrome-auth probe exists
    to exercise it, so it rides `cli_options` and must survive into the bundle.
    """
    agent = Agent(name="a", worker_type="claude", cli_options={"chrome": True})
    assert agent.to_agent_options().to_json()["chrome"] is True


def test_named_fields_win_over_cli_options():
    agent = Agent(name="a", model="haiku", cli_options={"model": "opus"})
    assert agent.to_agent_options().to_json()["model"] == "haiku"


# ── cold-start resolution ─────────────────────────────────────────────────────

def test_shipped_agent_resolves_off_disk_without_an_index():
    """Every converted launch site depends on this.

    The internal agents ship inside the package; resolving one must not wait for
    the indexer to have walked the assistant project, or a cold instance breaks.
    """
    agent = _shipped_agent("diagnose")
    assert agent is not None
    assert agent.name == "diagnose"
    assert agent.model == "haiku"
    assert agent.permission_mode == "bypassPermissions"
    assert agent.system_prompt


def test_shipped_agent_id_comes_from_the_capsule():
    """The disk fallback must BE the entity the indexer will produce.

    A minted id would give the same agent two deployment ids across the moment
    the walk lands, splitting its run history in half.
    """
    from flow_sdk.api.api_types.identifier import is_valid_entity_id

    first = _shipped_agent("diagnose")
    second = _shipped_agent("diagnose")
    assert first.id == second.id
    assert is_valid_entity_id(first.id)


def test_shipped_agent_reads_vendor_extras():
    assert _shipped_agent("chrome-auth").cli_options == {"chrome": True}


def test_unknown_shipped_agent_is_none_not_an_error():
    assert _shipped_agent("no-such-agent") is None


# ── frontmatter rendering ─────────────────────────────────────────────────────

def test_rendered_frontmatter_is_plain_yaml_not_a_pickle():
    """`agent.md` must stay a document, not a Python object graph.

    Entity fields arrive as TrackedList/TrackedDict, which carry a `_parent`
    backref to the entity. PyYAML has no representer for them, so without the
    plain-value coercion it emits `!!python/object/new:` and drags the WHOLE
    Agent — absolute paths, pydantic internals — into the frontmatter. A live
    UI edit produced exactly that.
    """
    from tests.unit.agent._parse import agent_default_body

    agent = Agent(
        name="probe",
        avatar="Wrench",
        cli_options={"chrome": True, "nested": {"a": 1}},
        subagents=["helper"],
    )
    rendered = agent_default_body(agent)

    assert "python/object" not in rendered
    assert "TrackedDict" not in rendered and "TrackedList" not in rendered
    # and the values still survive, nested shape intact
    assert "chrome: true" in rendered
    assert "nested:" in rendered
    assert "- helper" in rendered


def test_rendered_frontmatter_round_trips_through_the_parser():
    """Whatever we render must parse back to the same values."""
    from tests.unit.agent._parse import agent_default_body, parse_agent_markdown

    agent = Agent(
        name="probe",
        avatar="🌐",
        worker_type="claude",
        model="haiku",
        cli_options={"chrome": True},
        subagents=["a", "b"],
    )
    parsed = parse_agent_markdown(agent_default_body(agent), "probe")

    assert parsed["avatar"] == "🌐"
    assert parsed["cli_options"] == {"chrome": True}
    assert parsed["subagents"] == ["a", "b"]


def test_q_identity_round_trips_as_a_portable_bundle():
    """Name, display title, and sibling image ref survive a clean parse."""
    from tests.unit.agent._parse import agent_default_body, parse_agent_markdown

    rendered = agent_default_body(
        Agent(name="Q", title="QA manager", avatar="./avatar.png")
    )
    parsed = parse_agent_markdown(rendered, "q")

    assert parsed["name"] == "Q"
    assert parsed["title"] == "QA manager"
    assert parsed["avatar"] == "./avatar.png"
    assert "/Users/" not in rendered and "\\Users\\" not in rendered
