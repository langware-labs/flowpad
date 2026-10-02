"""OpenCode's login is the provider credentials it stores -- read from ``opencode providers list``.

OpenCode has no account of its own. ``opencode providers login`` stores a provider credential
(an API key, or a provider OAuth) in ``auth.json``, and that store is what makes it signed in.
Keys that only reach it through the environment are a stored LLM key funding the spawn, not
OpenCode's login. ``NONE_STORED`` is captured from the real CLI (1.18.31), ANSI included;
``TWO_STORED`` follows the same bullet layout with stored credentials (not captured live).
"""

from __future__ import annotations

import subprocess

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers import auth_probe
from flow_sdk.builtin.agentic_process.cli_drivers.auth_probe import WorkerAuthStatus, probe_opencode_auth

NONE_STORED = (
    "\x1b[0m\n┌  Credentials \x1b[90m~/.local/share/opencode/auth.json\n│\n└  0 credentials\n\n"
    "┌  Environment\n│\n●  OpenRouter \x1b[90mOPENROUTER_API_KEY\n│\n└  1 environment variable\n"
)
TWO_STORED = (
    "\x1b[0m\n┌  Credentials \x1b[90m~/.local/share/opencode/auth.json\n│\n"
    "●  Anthropic  \x1b[90moauth\n│\n●  OpenRouter  \x1b[90mapi\n│\n└  2 credentials\n"
)


def _cli(monkeypatch, stdout: str, returncode: int = 0):
    monkeypatch.setattr(
        auth_probe,
        "_run_cli",
        lambda argv, env, timeout: subprocess.CompletedProcess(argv, returncode, stdout=stdout, stderr=""),
    )


def test_stored_credentials_are_a_sign_in_naming_the_providers(monkeypatch):
    _cli(monkeypatch, TWO_STORED)
    result = probe_opencode_auth("/bin/opencode", {})
    assert result.status is WorkerAuthStatus.LOGGED_IN
    assert result.identity == "Anthropic, OpenRouter"


def test_an_environment_key_alone_is_not_opencodes_login(monkeypatch):
    _cli(monkeypatch, NONE_STORED)
    result = probe_opencode_auth("/bin/opencode", {})
    assert result.status is WorkerAuthStatus.LOGGED_OUT
    assert result.verified


@pytest.mark.parametrize(("stdout", "code"), [("", 1), ("something unexpected", 0)])
def test_output_it_cannot_read_is_unknown_not_signed_out(monkeypatch, stdout, code):
    """An undetermined probe must never assert a sign-out (the probe contract)."""
    _cli(monkeypatch, stdout, code)
    assert probe_opencode_auth("/bin/opencode", {}).status is WorkerAuthStatus.UNKNOWN
