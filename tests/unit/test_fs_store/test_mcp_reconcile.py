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


def test_parse_cli_list_keeps_plugin_qualified_names_distinct() -> None:
    """Plugin servers are named ``plugin:<plugin>:<server>`` — don't split on the first colon.

    A first-colon split truncated every plugin row to the literal "plugin",
    so the two rows below collapsed into one and `only_in_cli` reported a
    single bogus entry named "plugin".
    """
    text = (
        "Checking MCP server health…\n"
        "\n"
        "plugin:slack:slack: https://mcp.slack.com/mcp (HTTP) - ✔ Connected\n"
        "plugin:atlassian:atlassian: https://mcp.atlassian.com/v1/mcp/authv2 (HTTP) - ✔ Connected\n"
        "pycharm: http://127.0.0.1:64655/stream (HTTP) - ✔ Connected\n"
    )
    rows = _parse_cli_list(text)
    by_name = {r["name"]: r["launch"] for r in rows}

    assert sorted(by_name) == [
        "plugin:atlassian:atlassian",
        "plugin:slack:slack",
        "pycharm",
    ]
    assert by_name["plugin:slack:slack"] == "https://mcp.slack.com/mcp (HTTP)"
    assert by_name["plugin:atlassian:atlassian"] == (
        "https://mcp.atlassian.com/v1/mcp/authv2 (HTTP)"
    )
    # A colon inside the launch line (scheme, or host:port) is not the delimiter.
    assert by_name["pycharm"] == "http://127.0.0.1:64655/stream (HTTP)"
