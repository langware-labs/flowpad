import io
import json
import sys
from pathlib import Path

import pytest
import typer

from flow_sdk.cli import flow_cli


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
    monkeypatch.setattr(flow_cli.requests, "post", fake_post)

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
    monkeypatch.setattr(flow_cli.requests, "post", fake_post)
    # Ensure server.json discovery doesn't short-circuit the LOCAL_SERVER_PORT fallback
    monkeypatch.setattr(
        "flow_sdk.discovery.flowpad_discovery.read_all_server_infos", lambda: []
    )

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

    monkeypatch.setattr(flow_cli.requests, "post", fake_post)

    _invoke_hooks_report("{invalid json", hook_entry_id="hook-1")

    assert calls == []
