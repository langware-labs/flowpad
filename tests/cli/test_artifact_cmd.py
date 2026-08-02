"""`flow artifact` — the exit contract agents parse.

Argument validation and process-scope resolution happen before any network call,
so these run without a server. The contract deliberately reuses the numbers
``flow show`` published (0 / 2 / 4 / 5) — an agent's existing error handling
carries over unchanged when the verb is swapped.
"""

from __future__ import annotations

import json

import pytest
from typer.testing import CliRunner

from flow_sdk.cli.commands import artifact_cmd
from flow_sdk.cli.flow_cli import app

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

runner = CliRunner()

_TYPE_ID = "skill-3f2a1b4c-0000-4000-8000-000000000001"
_PROC = "--process=3f2a1b4c-0000-4000-8000-0000000000aa"


def _envelope(result) -> dict:
    """The last JSON line on stderr — the parseable failure envelope."""
    lines = [ln for ln in (result.stderr or "").splitlines() if ln.startswith("{")]
    assert lines, f"no JSON envelope in stderr: {result.stderr!r}"
    return json.loads(lines[-1])


# ── the verb exists and is discoverable ───────────────────────────────────────


def test_artifact_group_is_registered():
    result = runner.invoke(app, ["artifact", "--help"])

    assert result.exit_code == 0
    for sub in ("entity", "file", "webapp"):
        assert sub in result.output


# ── invalid arguments → exit 2 ────────────────────────────────────────────────


def test_malformed_typeid_exits_2():
    result = runner.invoke(app, ["artifact", "entity", "notatypeid", _PROC])

    assert result.exit_code == artifact_cmd.EXIT_INVALID_ARG
    assert _envelope(result)["error_code"] == "INVALID_TYPEID"


def test_empty_path_exits_2():
    result = runner.invoke(app, ["artifact", "file", "   ", _PROC])

    assert result.exit_code == artifact_cmd.EXIT_INVALID_ARG
    assert _envelope(result)["error_code"] == "INVALID_PATH"


@pytest.mark.parametrize("port", ["0", "99999"])
def test_bad_port_exits_2(port):
    result = runner.invoke(app, ["artifact", "webapp", "--port", port, _PROC])

    assert result.exit_code == artifact_cmd.EXIT_INVALID_ARG
    assert _envelope(result)["error_code"] == "INVALID_PORT"


def test_no_process_scope_exits_2(monkeypatch):
    """Without --process and without FLOWPAD_EXECUTION_SCOPE there is no run to
    attribute the artifact to — provenance is never guessed."""
    monkeypatch.delenv("FLOWPAD_EXECUTION_SCOPE", raising=False)

    result = runner.invoke(app, ["artifact", "entity", _TYPE_ID])

    assert result.exit_code == artifact_cmd.EXIT_INVALID_ARG
    assert _envelope(result)["error_code"] == "NO_PROCESS"


# ── server unreachable → exit 5 ───────────────────────────────────────────────


def test_server_down_exits_5(monkeypatch):
    monkeypatch.setattr(artifact_cmd, "_discover_port", lambda: 1)  # nothing listens

    result = runner.invoke(app, ["artifact", "entity", _TYPE_ID, _PROC])

    assert result.exit_code == artifact_cmd.EXIT_CONNECTION_ERROR


# ── process addressing ────────────────────────────────────────────────────────


def test_process_typeid_form_is_accepted(monkeypatch):
    """``--process agentic_process-<id>`` and a bare id must address the same
    run — the agent may have either form to hand."""
    seen: dict = {}

    def _capture(url, payload, *, timeout, on_error):
        seen["url"] = url
        return {"artifact": {"id": "a1"}, "shown": True}

    monkeypatch.setattr(artifact_cmd, "_discover_port", lambda: 9999)
    monkeypatch.setattr(artifact_cmd, "_post_graph_json", _capture)

    bare = runner.invoke(app, ["artifact", "entity", _TYPE_ID, _PROC])
    bare_url = seen["url"]
    typed = runner.invoke(
        app,
        ["artifact", "entity", _TYPE_ID, "--process=agentic_process-3f2a1b4c-0000-4000-8000-0000000000aa"],
    )

    assert bare.exit_code == 0 and typed.exit_code == 0
    assert seen["url"] == bare_url


def test_success_prints_a_parseable_envelope(monkeypatch):
    monkeypatch.setattr(artifact_cmd, "_discover_port", lambda: 9999)
    monkeypatch.setattr(
        artifact_cmd,
        "_post_graph_json",
        lambda url, payload, *, timeout, on_error: {"artifact": {"id": "a1"}, "shown": True},
    )

    result = runner.invoke(app, ["artifact", "file", "/tmp/report.html", _PROC])

    assert result.exit_code == 0
    payload = json.loads(result.output.strip().splitlines()[-1])
    assert payload["ok"] is True
    assert payload["artifact_id"] == "a1"
    assert payload["shown"] is True


def test_no_show_is_forwarded(monkeypatch):
    """Registering without stealing the display must reach the action."""
    seen: dict = {}

    monkeypatch.setattr(artifact_cmd, "_discover_port", lambda: 9999)
    monkeypatch.setattr(
        artifact_cmd,
        "_post_graph_json",
        lambda url, payload, *, timeout, on_error: seen.update(payload) or {"artifact": {}},
    )

    result = runner.invoke(app, ["artifact", "file", "/tmp/r.html", "--no-show", _PROC])

    assert result.exit_code == 0
    assert seen["show"] is False
