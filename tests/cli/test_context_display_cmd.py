"""`flow context display` — the agent's on-demand read of its display context.

The real Typer app runs; only the transport under it is replaced. Asserts the
process it targets (explicit ``--process`` or the calling worker's scope) and
the stable exit contract agents parse.
"""

from __future__ import annotations

import json

import pytest
from typer.testing import CliRunner

from flow_sdk.cli.commands import context_cmd
from flow_sdk.cli.flow_cli import app

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

runner = CliRunner()

PID = "3f2a1b4c-0000-4000-8000-0000000000aa"
STATE = {"fresh": True, "target": {"kind": "vfs", "path": "/p.html"}, "version": 2, "updated_at": "t", "data": {"lesson": 3}}


@pytest.fixture
def server(monkeypatch):
    """Replace the transport: record each GET, answer ``STATE`` or the status set in ``answer``."""
    calls: list[str] = []
    answer = {"status": 200}

    def _fake_get(url, params=None, timeout=None, on_error=None):
        calls.append(url)
        if answer["status"] != 200:
            on_error(answer["status"], {"message": "not found"})
        return STATE

    monkeypatch.setattr(context_cmd, "_discover_port", lambda: 9999)
    monkeypatch.setattr(context_cmd, "_get_graph_json", _fake_get)
    return calls, answer


def test_it_reads_the_named_process(server):
    calls, _ = server
    result = runner.invoke(app, ["context", "display", "--process", PID])

    assert result.exit_code == 0, result.output
    assert calls == [f"http://127.0.0.1:9999/api/v1/graph/agentic_process/{PID}/display-context"]
    out = json.loads(result.output)
    assert out["process_id"] == PID and out["data"] == {"lesson": 3} and out["version"] == 2


def test_a_worker_reads_its_own_process(server, monkeypatch):
    calls, _ = server
    monkeypatch.setenv("FLOWPAD_EXECUTION_SCOPE", json.dumps([f"agentic_process-{PID}"]))

    result = runner.invoke(app, ["context", "display"])

    assert result.exit_code == 0, result.output
    assert calls and PID in calls[0]


def test_a_missing_process_exits_not_found(server):
    _, answer = server
    answer["status"] = 404

    result = runner.invoke(app, ["context", "display", "--process", PID])

    assert result.exit_code == context_cmd.EXIT_NOT_FOUND, result.output
