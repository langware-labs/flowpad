"""MCP capability derivation — kind grammar, normalization, runner basics."""

from __future__ import annotations

from flow_sdk.core.capabilities.models import (
    capability_kind_matches,
    is_mcp_capability_kind,
)
from flow_sdk.core.capabilities.mcp import (
    McpServerCapabilityRunner,
    mcp_capability_kind,
    normalize_service,
)


def test_normalize_service() -> None:
    assert normalize_service("claude.ai Gmail") == "gmail"
    assert normalize_service("Google_Calendar") == "googlecalendar"
    assert normalize_service("debugMcp") == "debugmcp"
    assert normalize_service("claude_ai_Slack") == "slack"


def test_kind_grammar_is_service_first_and_prefix_resolvable() -> None:
    kind = mcp_capability_kind("calendar", "claude_code")
    assert kind == "calendar.mcp.claude_code"
    # An agent asking for the bare service (or service.mcp) resolves the leaf.
    assert capability_kind_matches("calendar", kind)
    assert capability_kind_matches("calendar.mcp", kind)
    assert capability_kind_matches("calendar.mcp.claude_code", kind)
    # A different service does not match.
    assert not capability_kind_matches("gmail", kind)


def test_is_mcp_capability_kind() -> None:
    assert is_mcp_capability_kind("gmail.mcp.claude_code")
    assert not is_mcp_capability_kind("harness.claude.cli")
    assert not is_mcp_capability_kind("gmail")


async def test_runner_check_install_test() -> None:
    from flow_sdk.core.capabilities.mcp import _spec_for

    entry = {"service": "gmail", "worker_type": "claude_code",
             "record_ids": ["abc"], "names": ["claude.ai Gmail"]}
    spec = _spec_for("gmail.mcp.claude_code", entry)
    runner = McpServerCapabilityRunner(
        spec, service="gmail", worker_type="claude_code", record_ids=["abc"]
    )

    check = await runner.check()
    assert check.available and check.ok
    assert check.details["service"] == "gmail"

    # install() is a no-op for MCP capabilities (configured, not installed).
    install = await runner.install()
    assert "configured, not installed" in install.message

    # test() mirrors check() for now.
    test = await runner.test()
    assert test.available == check.available
