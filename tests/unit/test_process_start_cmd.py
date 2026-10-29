"""`flow process start "<prompt>"`: one headless turn in-process, streamed, its verdict the exit code.

On the mock worker, so no CLI is spawned and no model is called. The live, loginless proof — a
container with only the wheel, funded by a public hub endpoint — is
``tests/long_tests/test_loginless_in_docker.py``.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from typer.testing import CliRunner

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.cli.commands import process_cmd
from flow_sdk.core.headless_turn import HeadlessTurnRequest
from flow_sdk.flowpad_types.enums.worker_enums import WorkerType
from flow_sdk.transcript_analyzer.worker_status import WorkerStatus


@pytest.fixture(autouse=True)
def _no_bootstrap():
    # ``@local`` + a compute node, which the shared test DB already has; this file tests the turn.
    with patch("flow_sdk.migrations.runner._bootstrap_local", new_callable=AsyncMock):
        yield


def _req(prompt: str, **fields) -> HeadlessTurnRequest:
    return HeadlessTurnRequest(prompt=prompt, **fields)


async def test_streams_the_answer_and_exits_ok(mock_driver, tmp_path, capsys):
    driver = mock_driver(response_for=lambda prompt: "pong")
    rc = await process_cmd._run_start(_req("say pong", worker="claude_code", workdir=str(tmp_path)))
    out, err = capsys.readouterr()
    assert rc == 0
    assert out.strip().splitlines()[-1] == "pong"
    assert "running agentic process agentic_process-" in err
    assert "pong" not in err  # the answer is stdout's alone
    assert driver.received_prompts and "say pong" in driver.received_prompts[-1]


async def test_a_failed_turn_is_a_nonzero_exit_with_its_reason(mock_driver, tmp_path, capsys):
    mock_driver(response_for=lambda prompt: "half an answer")
    with patch.object(AgenticProcess, "fetch_worker_status", return_value=WorkerStatus.ERROR):
        rc = await process_cmd._run_start(_req("go", worker="claude_code", workdir=str(tmp_path)))
    _, err = capsys.readouterr()
    assert rc == 1
    assert err.strip().splitlines()[-1]  # says why, not just a code


async def test_a_worker_that_never_starts_is_an_answer_not_a_raise(mock_driver, tmp_path, capsys):
    mock_driver()
    with patch.object(AgenticProcess, "stream_transcript", side_effect=RuntimeError("no usable LLM source")):
        rc = await process_cmd._run_start(_req("go", worker="claude_code", workdir=str(tmp_path)))
    _, err = capsys.readouterr()
    assert rc == 1
    assert "no usable LLM source" in err


async def test_with_no_worker_named_the_builtin_rule_picks_it(mock_driver, tmp_path):
    """No ``--worker`` takes ``resolve_builtin_worker_type`` — the selected harness when
    installed, else deepagents (that rule's own cases: test_builtin_worker_resolution.py)."""
    mock_driver(response_for=lambda prompt: "ok")
    rule = AsyncMock(return_value=WorkerType.DEEPAGENTS.value)
    with patch("flow_sdk.core.capabilities.registry.resolve_builtin_worker_type", rule):
        assert await process_cmd._run_start(_req("go", workdir=str(tmp_path))) == 0
    rule.assert_awaited_once()


async def test_a_reply_the_stream_missed_is_still_printed(mock_driver, tmp_path, capsys):
    """codex can write its last message as the session closes, after the stream saw the turn end;
    the engine's answer re-reads the transcript, and that answer is what gets printed."""
    from flow_sdk.builtin.agent_serve import TurnEvent
    from flow_sdk.schema.data_spec.returned_value_spec import PromptResult

    mock_driver()

    async def late(self, turn, *, process=None):
        yield TurnEvent("done", answer=PromptResult.satisfied("ok", text="hello late"))

    with patch("flow_sdk.builtin.agent_serve.TurnEngine.run_stream", late):
        rc = await process_cmd._run_start(_req("go", worker="claude_code", workdir=str(tmp_path)))
    out, _ = capsys.readouterr()
    assert rc == 0 and out.strip() == "hello late"


async def test_the_server_route_streams_the_turn_as_ndjson(mock_driver, tmp_path):
    """With a backend up the turn runs INSIDE it: the route answers one JSON event per line."""
    import json

    import httpx
    from fastapi import FastAPI

    from flow_sdk.server.routes.headless_turn import router

    mock_driver(response_for=lambda prompt: "pong")
    app = FastAPI()
    app.include_router(router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://box") as client:
        resp = await client.post(
            "/api/v1/agentic_process/headless-turn",
            json={"prompt": "say pong", "worker": "claude_code", "workdir": str(tmp_path)},
        )
    events = [json.loads(line) for line in resp.text.splitlines() if line]
    assert resp.status_code == 200
    assert events[0]["kind"] == "process" and events[0]["id"].startswith("agentic_process-")
    assert any(e["kind"] == "text" and e["text"] == "pong" for e in events)
    assert events[-1]["kind"] == "done" and events[-1]["ok"] is True and events[-1]["exit_code"] == 0


def test_beside_a_running_backend_the_cli_prints_the_servers_stream(capsys):
    """The CLI half: a live HTTP server answering NDJSON is printed exactly like an in-process turn."""
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    lines = (
        b'{"kind": "process", "id": "agentic_process-x"}\n'
        b'{"kind": "tool", "name": "Write"}\n'
        b'{"kind": "text", "text": "built it"}\n'
        b'{"kind": "done", "ok": true, "exit_code": 0, "text": "", "detail": ""}\n'
    )

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802 -- http.server's name
            self.rfile.read(int(self.headers.get("content-length") or 0))
            self.send_response(200)
            self.send_header("content-type", "application/x-ndjson")
            self.end_headers()
            self.wfile.write(lines)

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        rc = process_cmd._run_on_server(server.server_port, _req("build it", worker="claude"))
    finally:
        server.shutdown()
    out, err = capsys.readouterr()
    assert rc == 0
    assert out.strip() == "built it"
    assert "running agentic process agentic_process-x" in err and "· Write" in err


def test_an_unknown_worker_is_an_invalid_argument():
    with patch.object(process_cmd, "_discover_port", return_value=None):
        result = CliRunner().invoke(process_cmd.process_app, ["start", "hi", "--worker", "nope"])
    assert result.exit_code == process_cmd.EXIT_INVALID_ARG
    assert "UNKNOWN_WORKER" in result.output


def test_a_stream_that_ends_without_a_result_is_a_failure_that_says_so(capsys):
    printer = process_cmd._Printer()
    printer.feed({"kind": "process", "id": "agentic_process-x"})
    printer.feed({"kind": "text", "text": "half"})
    assert printer.result() == 1
    assert "ended before it reported a result" in capsys.readouterr().err

