"""``AgentOptions.to_json()`` is a WIRE format — pin it byte-for-byte.

``AgenticProcess.last_started_hash`` is an md5 over ``json.dumps(to_json())``,
so any change to the key set, a key name, or a value's type silently
invalidates every stored restart snapshot and makes running processes look
restart-worthy. These snapshots are the guard for that: every vendor, every
field set to a non-default value.

``from_json(to_json())`` round-trips back to an equal options object, so the
snapshot also covers the reader.
"""

from __future__ import annotations

import json

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli import ClaudeAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.codex.cli import CodexAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.cli import CopilotAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.opencode.cli import OpenCodeAgentOptions

COMMON = dict(workdir="/w", env_vars={"B": "2", "A": "1"})


def _claude() -> ClaudeAgentOptions:
    return ClaudeAgentOptions(
        session_id="s-1", resume=True, fork_session_id="f-1", model="md", debug=True,
        debug_file="/d.txt", permission_mode="acceptEdits", chrome=True, worktree=True,
        agents_json={"a": 1}, print_mode=True, add_dirs=["/x", "/y"],
        output_format="stream-json", verbose=True, effort="high", **COMMON,
    )


def _codex() -> CodexAgentOptions:
    return CodexAgentOptions(
        session_id="s-2", resume=True, model="lg", permission_mode="acceptEdits",
        skill_names=["k1", "k2"], add_dirs=["/x"], json_stream=False, ephemeral=False, **COMMON,
    )


def _copilot() -> CopilotAgentOptions:
    return CopilotAgentOptions(
        session_id="s-3", resume=True, model="sm", permission_mode="acceptEdits", effort="low",
        skill_names=["k1"], add_dirs=["/x"], json_stream=False, no_ask_user=False,
        no_auto_update=False, no_custom_instructions=False, allow_all=False, **COMMON,
    )


def _opencode() -> OpenCodeAgentOptions:
    return OpenCodeAgentOptions(
        session_id="s-4", resume=True, fork_session_id="f-4", model="md",
        permission_mode="acceptEdits", agent="build", variant="v2", skill_names=["k1"],
        add_dirs=["/x"], json_stream=False, **COMMON,
    )


GOLDEN = {
    "claude": (
        '{"add_dirs": ["/x", "/y"], "agents_json": {"a": 1}, "chrome": true, "debug": true, '
        '"debug_file": "/d.txt", "effort": "high", "env_vars": {"A": "1", "B": "2", '
        '"CLAUDE_PROJECT_DIR": "/w"}, "fork_session_id": "f-1", "model": "md", '
        '"output_format": "stream-json", "permission_mode": "acceptEdits", "print_mode": true, '
        '"resume": true, "session_id": "s-1", "verbose": true, "workdir": "/w", '
        '"worker_type": "claude", "worktree": true}'
    ),
    "codex": (
        '{"add_dirs": ["/x"], "env_vars": {"A": "1", "B": "2"}, "ephemeral": false, '
        '"json_stream": false, "model": "lg", "permission_mode": "acceptEdits", "resume": true, '
        '"session_id": "s-2", "skill_names": ["k1", "k2"], "workdir": "/w", "worker_type": "codex"}'
    ),
    "copilot": (
        '{"add_dirs": ["/x"], "allow_all": false, "effort": "low", '
        '"env_vars": {"A": "1", "B": "2"}, "json_stream": false, "model": "sm", '
        '"no_ask_user": false, "no_auto_update": false, "no_custom_instructions": false, '
        '"permission_mode": "acceptEdits", "resume": true, "session_id": "s-3", '
        '"skill_names": ["k1"], "workdir": "/w", "worker_type": "copilot"}'
    ),
    "opencode": (
        '{"add_dirs": ["/x"], "agent": "build", "env_vars": {"A": "1", "B": "2"}, '
        '"fork_session_id": "f-4", "json_stream": false, "model": "md", '
        '"permission_mode": "acceptEdits", "resume": true, "session_id": "s-4", '
        '"skill_names": ["k1"], "variant": "v2", "workdir": "/w", "worker_type": "opencode"}'
    ),
}

BUILDERS = {"claude": _claude, "codex": _codex, "copilot": _copilot, "opencode": _opencode}


@pytest.mark.parametrize("vendor", sorted(GOLDEN))
def test_to_json_is_byte_identical(vendor):
    assert json.dumps(BUILDERS[vendor]().to_json(), sort_keys=True) == GOLDEN[vendor]


@pytest.mark.parametrize("vendor", sorted(GOLDEN))
def test_from_json_round_trips(vendor):
    original = BUILDERS[vendor]()
    payload = original.to_json()
    restored = type(original).from_json(payload)
    assert json.dumps(restored.to_json(), sort_keys=True) == GOLDEN[vendor]
    assert restored == original
