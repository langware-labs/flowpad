"""Pure contracts for structured CLI values and shell rendering."""

from __future__ import annotations

import json
import shlex
from collections.abc import Callable
from typing import Any

import pytest

try:
    import tomllib
except ImportError:  # pragma: no cover - Python < 3.11
    import tomli as tomllib

from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli import ClaudeAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.cli_serialization import (
    quote_powershell_literal,
    quote_shell_arg,
    serialize_json_cli_value,
    serialize_toml_cli_value,
)

COMPLEX_VALUE = {
    "spaced key": "O'Brien \"quoted\" \\ path\r\nשלום 😀\x7f",
    "enabled": True,
    "nested": [1, 2.5, {"hyphen-key": "value"}],
}


@pytest.mark.parametrize(
    ("encode", "decode"),
    [
        (serialize_json_cli_value, json.loads),
        (serialize_toml_cli_value, lambda value: tomllib.loads(f"value={value}")["value"]),
    ],
)
def test_structured_cli_value_round_trips(
    encode: Callable[[Any], str], decode: Callable[[str], Any]
) -> None:
    encoded = encode(COMPLEX_VALUE)
    assert decode(encoded) == COMPLEX_VALUE
    if encode is serialize_json_cli_value:
        argv = ClaudeAgentOptions(agents_json=COMPLEX_VALUE).cli_cmd()
        assert argv[argv.index("--agents") + 1] == encoded


@pytest.mark.parametrize(
    "value",
    [None, float("nan"), float("inf"), float("-inf"), {1: "value"}, object()],
)
def test_toml_cli_value_rejects_unsupported_values(value: object) -> None:
    with pytest.raises((TypeError, ValueError)):
        serialize_toml_cli_value(value)


def test_shell_argument_quoting_is_platform_correct() -> None:
    value = "O'Brien with spaces"
    assert shlex.split(quote_shell_arg(value, "linux")) == [value]
    assert quote_shell_arg("safe_@%+=:,./-09", "win32") == "safe_@%+=:,./-09"
    assert quote_shell_arg("O'Brien", "win32") == "'O''Brien'"
    assert quote_powershell_literal("O'Brien") == "'O''Brien'"
