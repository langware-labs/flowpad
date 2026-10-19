"""Codex and copilot say WHO is signed in from their own config files -- read, never verified.

``codex login status`` answers only WHETHER (its exit code). WHO and on WHAT plan live in the
id_token codex stores in ``$CODEX_HOME/auth.json``; its payload is decoded locally for the
``email`` and ChatGPT plan claims. Copilot's ``config.json`` names its last-used login. Neither
file changes the verdict: a missing or garbled file is still a sign-in with no account named,
and the token itself never reaches a message or the details.
"""

from __future__ import annotations

import base64
import json
import subprocess
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers import auth_probe
from flow_sdk.builtin.agentic_process.cli_drivers.auth_probe import (
    WorkerAuthStatus,
    probe_codex_auth,
    probe_copilot_auth,
)


def _cli(monkeypatch, stdout: str = "Logged in using ChatGPT", returncode: int = 0):
    monkeypatch.setattr(
        auth_probe,
        "_run_cli",
        lambda argv, env, timeout: subprocess.CompletedProcess(argv, returncode, stdout=stdout, stderr=""),
    )


def _jwt(payload: dict) -> str:
    """An unsigned ``header.payload.sig`` -- the probe reads claims, it never checks a signature."""
    seg = lambda obj: base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()  # noqa: E731
    return f"{seg({'alg': 'none'})}.{seg(payload)}.sig"


TOKEN = _jwt({"email": "dev@example.com", "https://api.openai.com/auth": {"chatgpt_plan_type": "plus"}})


def _auth_json(home: Path, token: str | None = TOKEN, raw: str | None = None) -> Path:
    path = home / ".codex" / "auth.json"
    path.parent.mkdir(parents=True)
    path.write_text(raw if raw is not None else json.dumps({"tokens": {"id_token": token}}), encoding="utf-8")
    return path


def test_the_id_token_names_the_account_and_its_plan(monkeypatch, tmp_path):
    _cli(monkeypatch)
    _auth_json(tmp_path)
    result = probe_codex_auth("/bin/codex", {}, home=tmp_path)
    assert result.status is WorkerAuthStatus.LOGGED_IN and result.verified
    assert (result.identity, result.plan) == ("dev@example.com", "plus")
    assert result.message == "Logged in using ChatGPT"


def test_codex_home_redirects_where_the_token_is_read(monkeypatch, tmp_path):
    _cli(monkeypatch)
    _auth_json(tmp_path / "elsewhere")
    result = probe_codex_auth("/bin/codex", {"CODEX_HOME": str(tmp_path / "elsewhere" / ".codex")}, home=tmp_path)
    assert result.identity == "dev@example.com"


@pytest.mark.parametrize(
    "setup",
    [
        lambda home: None,  # no auth.json at all
        lambda home: _auth_json(home, raw="{not json"),
        lambda home: _auth_json(home, raw=json.dumps({"tokens": {}})),
        lambda home: _auth_json(home, token="not.a.jwt"),
        lambda home: _auth_json(home, token=_jwt({"sub": "no email claim"})),
    ],
    ids=["missing", "garbled", "no-token", "undecodable", "claimless"],
)
def test_an_unreadable_token_leaves_the_sign_in_with_no_account(monkeypatch, tmp_path, setup):
    _cli(monkeypatch)
    setup(tmp_path)
    result = probe_codex_auth("/bin/codex", {}, home=tmp_path)
    assert result.status is WorkerAuthStatus.LOGGED_IN
    assert (result.identity, result.plan) == ("", "")


def test_the_token_never_leaks_into_the_message_or_details(monkeypatch, tmp_path):
    _cli(monkeypatch)
    _auth_json(tmp_path)
    result = probe_codex_auth("/bin/codex", {}, home=tmp_path)
    assert TOKEN not in result.message
    assert TOKEN not in json.dumps(result.details)
    assert TOKEN not in json.dumps(result.to_json())


def test_a_sign_out_reads_no_file(monkeypatch, tmp_path):
    _cli(monkeypatch, stdout="Not logged in", returncode=1)
    _auth_json(tmp_path)
    result = probe_codex_auth("/bin/codex", {}, home=tmp_path)
    assert result.status is WorkerAuthStatus.LOGGED_OUT
    assert (result.identity, result.plan) == ("", "")


# ── copilot ────────────────────────────────────────────────────────────────────


def _copilot_config(home: Path, body: dict) -> None:
    path = home / ".copilot" / "config.json"
    path.parent.mkdir(parents=True)
    path.write_text("// written by copilot\n// do not edit\n" + json.dumps(body), encoding="utf-8")


def test_copilots_last_used_login_is_the_identity(tmp_path):
    _copilot_config(
        tmp_path,
        {
            "loggedInUsers": [{"host": "https://github.com", "login": "octocat"}, {"login": "hubot"}],
            # The real file's marker is an object, not the bare login.
            "lastLoggedInUser": {"host": "https://github.com", "login": "octocat"},
        },
    )
    result = probe_copilot_auth({}, tmp_path)
    assert result.status is WorkerAuthStatus.LOGGED_IN
    assert result.identity == "octocat" and result.plan == ""
    assert result.details["users"] == ["octocat", "hubot"]


def test_a_bare_string_marker_is_tolerated(tmp_path):
    _copilot_config(tmp_path, {"loggedInUsers": [{"login": "octocat"}], "lastLoggedInUser": "octocat"})
    assert probe_copilot_auth({}, tmp_path).identity == "octocat"


def test_without_a_last_used_marker_the_latest_login_is_the_identity(tmp_path):
    _copilot_config(tmp_path, {"loggedInUsers": [{"login": "octocat"}, {"login": "hubot"}]})
    assert probe_copilot_auth({}, tmp_path).identity == "hubot"
