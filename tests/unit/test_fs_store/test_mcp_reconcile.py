"""MCP reconcile — `claude mcp list` parsing + name normalization."""

from __future__ import annotations

from flow_sdk.builtin.faas.mcp_reconcile import _normalize_name, _parse_cli_list


def test_parse_cli_list_extracts_name_and_launch() -> None:
    text = (
        "Checking MCP server health…\n"
        "\n"
        "claude.ai Atlassian Rovo: https://mcp.atlassian.com/v1/mcp - ✔ Connected\n"
        "debugMcp: npx @playwright/mcp@latest --cdp-endpoint http://localhost:9222 - ✔ Connected\n"
    )
    rows = _parse_cli_list(text)
    by_name = {r["name"]: r["launch"] for r in rows}
    assert by_name["claude.ai Atlassian Rovo"] == "https://mcp.atlassian.com/v1/mcp"
    assert by_name["debugMcp"].startswith("npx @playwright/mcp@latest")
    # The "Checking…" preamble line is skipped.
    assert "Checking MCP server health…" not in by_name


def test_parse_cli_list_skips_noise() -> None:
    assert _parse_cli_list("") == []
    assert _parse_cli_list("no colon here\n") == []


def test_normalize_name_is_case_and_space_insensitive() -> None:
    assert _normalize_name("  Claude.ai Gmail ") == "claude.ai gmail"
    assert _normalize_name("debugMcp") == "debugmcp"
