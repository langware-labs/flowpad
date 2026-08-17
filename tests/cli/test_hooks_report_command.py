import io
import json
import sys
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
import typer
from typer.testing import CliRunner

from flow_sdk.cli import flow_cli

runner = CliRunner()


@contextmanager
def _recording_server():
    requests_received = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0"))
            requests_received.append({"path": self.path, "json": json.loads(self.rfile.read(length))})
            body = b'{"status":"SUCCESS","data":{}}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_port, requests_received
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def _invoke_hooks_report(stdin_payload: str, hook_entry_id: str | None):
    original_stdin = sys.stdin
    sys.stdin = io.StringIO(stdin_payload)
    with pytest.raises(typer.Exit) as exc:
        try:
            flow_cli.hooks_report(hook_entry_id=hook_entry_id)
        finally:
            sys.stdin = original_stdin
    assert exc.value.exit_code == 0


def test_hooks_report_posts_agent_hook_envelope_with_entry_id(monkeypatch, tmp_path):
    hook_id = "hook-123"
    project_dir = tmp_path
    settings_path = project_dir / ".claude" / "settings.json"
    settings_path.parent.mkdir(parents=True)
    settings_path.write_text(
        json.dumps(
            {
                "hooks": {
                    "UserPromptSubmit": [
                        {
                            "matcher": "*",
                            "hooks": [
                                {
                                    "type": "command",
                                    "command": f"flow hooks report --hook-entry-id={hook_id}",
                                    "flow_metadata": {
                                        "name": "flowpad_sniffer",
                                        "hook_entry_id": hook_id,
                                        "flowpad_hook_id": hook_id,
                                    },
                                }
                            ],
                        }
                    ]
                }
            }
        ),
        encoding="utf-8",
    )

    calls = []

    def fake_post(url, json=None, timeout=None):
        calls.append({"url": url, "json": json, "timeout": timeout})
        return None

    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project_dir))
    monkeypatch.setenv("AGENT_HOOKS_REPORT_URL", "http://localhost:9007/api/v1/webhook/listen")
    monkeypatch.setattr("flow_sdk.cli.commands._common.local_post", fake_post)

    _invoke_hooks_report(
        json.dumps(
            {
                "hook_event_name": "PreToolUse",
                "session_id": "session-1",
                "tool_name": "Bash",
                "tool_input": {"command": "echo hi"},
                "cwd": str(project_dir),
            }
        ),
        hook_entry_id=hook_id,
    )

    assert len(calls) == 1
    call = calls[0]
    assert call["url"] == "http://localhost:9007/api/v1/webhook/listen"
    assert call["timeout"] == 5

    payload = call["json"]
    assert payload["webhook_type"] == "agent_hook"
    assert payload["webhook_payload"]["agent_hook_id"] == hook_id
    assert payload["webhook_payload"]["hook_entry_id"] == hook_id
    assert payload["webhook_payload"]["hook_file_path"] == str(settings_path)
    # hook_metadata is None because find_hook_metadata no longer scans settings files
    # (flow_metadata in command string was removed; identity is in --hook-entry-id)
    assert payload["webhook_payload"]["hook_metadata"] is None
    assert payload["webhook_payload"]["hook_data"]["hook_event_name"] == "PreToolUse"
    assert payload["webhook_payload"]["hook_data"]["tool_name"] == "Bash"
    assert payload["webhook_payload"]["hook_data"]["raw_hook_data"]["session_id"] == "session-1"


def test_hooks_report_falls_back_to_local_server_when_report_url_missing(monkeypatch):
    calls = []

    def fake_post(url, json=None, timeout=None):
        calls.append({"url": url, "json": json, "timeout": timeout})
        return None

    monkeypatch.delenv("AGENT_HOOKS_REPORT_URL", raising=False)
    monkeypatch.setenv("LOCAL_SERVER_PORT", "9123")
    monkeypatch.setattr("flow_sdk.cli.commands._common.local_post", fake_post)
    # Ensure server.json discovery doesn't short-circuit the LOCAL_SERVER_PORT fallback
    monkeypatch.setattr("flow_sdk.discovery.flowpad_discovery.read_all_server_infos", lambda: [])

    _invoke_hooks_report(
        json.dumps({"hook_event_name": "UserPromptSubmit", "prompt": "hello"}),
        hook_entry_id="hook-xyz",
    )

    assert len(calls) == 1
    call = calls[0]
    assert call["url"] == "http://127.0.0.1:9123/api/hooks/report"
    assert call["timeout"] == 5
    assert call["json"]["hook_entry_id"] == "hook-xyz"
    assert call["json"]["hook_metadata"] is None
    assert "hook_file_path" in call["json"]


def test_hooks_report_ignores_invalid_json(monkeypatch):
    calls = []

    def fake_post(url, json=None, timeout=None):
        calls.append({"url": url, "json": json, "timeout": timeout})
        return None

    monkeypatch.setattr("flow_sdk.cli.commands._common.local_post", fake_post)

    _invoke_hooks_report("{invalid json", hook_entry_id="hook-1")

    assert calls == []


@pytest.mark.parametrize(
    "process_id",
    [
        "11111111-1111-4111-8111-111111111111",
        "6ba7b810-9dad-51d1-80b4-00c04fd430c8",
    ],
    ids=["uuid4", "uuid5"],
)
def test_process_report_targets_only_flow_instance_and_preserves_native_json(process_id, monkeypatch, tmp_path):
    native = {
        "hook_event_name": "UserPromptSubmit",
        "prompt": "first line\nשורה שנייה 🧪",
        "session_id": "session-1",
        "nested": {"items": [True, {"quote": "O'Brien"}]},
    }
    loads = 0
    original_json_load = json.load

    def counting_json_load(stream):
        nonlocal loads
        if stream is sys.stdin:
            loads += 1
        return original_json_load(stream)

    def forbidden_instance_scan():
        raise AssertionError("process reports must not scan all Flow instances")

    monkeypatch.setattr(json, "load", counting_json_load)
    monkeypatch.setattr(
        "flow_sdk.discovery.flowpad_discovery.read_all_server_infos",
        forbidden_instance_scan,
    )
    with _recording_server() as (target_port, target), _recording_server() as (other_port, other):
        flow_home = tmp_path / "flow"
        selected = flow_home / "instances" / "hook-target"
        selected.mkdir(parents=True)
        (selected / "server.json").write_text(
            json.dumps({"port": target_port, "webhook_path": "/wrong", "health_path": "/health"}),
            encoding="utf-8",
        )
        monkeypatch.setenv("FLOW_HOME", str(flow_home))
        monkeypatch.setenv("FLOW_INSTANCE", "hook-target")
        monkeypatch.setenv("AGENT_HOOKS_REPORT_URL", f"http://127.0.0.1:{other_port}/must-not-run")

        result = runner.invoke(
            flow_cli.app,
            ["hooks", "report", "--process-id", process_id],
            input=json.dumps(native),
        )

    assert result.exit_code == 0, result.output
    assert loads == 1
    assert other == []
    assert [request["path"] for request in target] == ["/api/v1/webhook/listen"]
    payload = target[0]["json"]
    assert payload["webhook_type"] == "agent_hook"
    assert payload["webhook_payload"]["agentic_process_id"] == process_id
    assert payload["webhook_payload"]["hook_data"]["raw_hook_data"] == native


@pytest.mark.parametrize(
    "args,error",
    [
        (
            [
                "--process-id",
                "11111111-1111-4111-8111-111111111111",
                "--hook-entry-id",
                "hook-1",
            ],
            "mutually exclusive",
        ),
        (["--process-id", "0190f1c0-0000-7000-8000-000000000000"], "UUID v4 or v5"),
        (["--process-id", "not-a-uuid"], "UUID v4 or v5"),
    ],
)
def test_process_report_rejects_ambiguous_or_invalid_identity(args, error):
    result = runner.invoke(flow_cli.app, ["hooks", "report", *args], input="{}")

    assert result.exit_code != 0
    assert error in result.output
