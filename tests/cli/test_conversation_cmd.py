"""End-to-end tests for the ``flow conversation`` CLI group.

These drive the CLI exactly as a user would (Typer ``CliRunner`` → blocking
``requests``) against a REAL server (the threaded ``local_server`` fixture) so
the genuine REST actions + DB run — no server mocks. Effects are validated back
over REST (``conversation-summary`` / ``conversation-list``).

The send gate is pinned deterministic via monkeypatch: not Local mode, not
cloud-logged-in — so non-draft sends land as ``pending_send`` (same process, so
the server thread sees the patched module globals at call time).
"""
from __future__ import annotations

import json
import socket
import threading
import time

import pytest
import requests
from typer.testing import CliRunner

from flow_sdk.cli.commands import conversation_cmd
from flow_sdk.cli.flow_cli import app

runner = CliRunner()


def _free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture(scope="module")
def conv_server():
    """Start the real server (current code) once on a free port for this module.

    A dedicated free port avoids colliding with any stale/other server on the
    default test port. Daemon thread — torn down with the process.
    """
    from flow_sdk.server.app import start_server

    port = _free_port()
    threading.Thread(target=start_server, args=(port,), daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    # Readiness: poll the bootstrap endpoint until the server answers.
    deadline = time.time() + 15
    while time.time() < deadline:
        try:
            if requests.get(f"{base}/api/v1/graph/bootstrap", timeout=2).status_code == 200:
                break
        except requests.exceptions.RequestException:
            time.sleep(0.2)
    else:  # pragma: no cover
        pytest.fail("conv_server did not become ready")
    return type("Srv", (), {"base_url": base, "port": port})()


@pytest.fixture
def conv_cli(conv_server, monkeypatch):
    base = conv_server.base_url

    monkeypatch.setattr(conversation_cmd, "_discover_port", lambda: conv_server.port)
    monkeypatch.setattr("flow_sdk.instance_settings.privacy_mode.is_local_mode", lambda: False)
    monkeypatch.setattr("flow_sdk.cli.auth.hub_login.is_logged_in", lambda: False)
    monkeypatch.setattr("flow_sdk.app.actions.notification_action.is_logged_in", lambda: False)

    projects = requests.get(f"{base}/api/v1/graph/project", timeout=10).json()["data"]
    project_id = next(p for p in projects if p.get("uname") == "local")["id"]
    created = requests.post(
        f"{base}/api/v1/graph/conversation-create",
        json={"project_id": project_id, "participants": [{"email": "tzahi@example.com", "name": "Tzahi"}]},
        timeout=10,
    )
    conv_id = created.json()["data"]["conversation_id"]

    class Helper:
        def __init__(self):
            self.base = base
            self.conv_id = conv_id
            self.project_id = project_id

        def invoke(self, args):
            return runner.invoke(app, args)

        def ok_payload(self, result):
            assert result.exit_code == 0, result.output
            return json.loads(result.stdout.strip().splitlines()[-1])

        def summary_text(self):
            r = requests.post(
                f"{base}/api/v1/graph/conversation-summary",
                json={"conversation_id": conv_id},
                timeout=10,
            )
            return r.json()["data"]["summary"]

    return Helper()


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_list_reports_the_conversation(conv_cli):
    payload = conv_cli.ok_payload(conv_cli.invoke(["conversation", "list"]))
    ids = [c["id"] for c in payload["conversations"]]
    assert conv_cli.conv_id in ids
    row = next(c for c in payload["conversations"] if c["id"] == conv_cli.conv_id)
    assert any((p.get("name") == "Tzahi") for p in row["participants"])


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_send_lands_message_and_is_pending_when_logged_out(conv_cli):
    payload = conv_cli.ok_payload(
        conv_cli.invoke(["conversation", "send", conv_cli.conv_id, "hello from cli"])
    )
    assert payload["pending"] is True
    assert payload["delivery_status"] == "pending_send"
    summary = conv_cli.summary_text()
    assert "hello from cli" in summary
    assert "Messages: 1" in summary


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_summary_command_returns_text(conv_cli):
    conv_cli.invoke(["conversation", "send", conv_cli.conv_id, "one"])
    conv_cli.invoke(["conversation", "send", conv_cli.conv_id, "two"])
    payload = conv_cli.ok_payload(conv_cli.invoke(["conversation", "summary", conv_cli.conv_id]))
    assert "Conversation:" in payload["summary"]
    assert "one" in payload["summary"] and "two" in payload["summary"]


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_attach_file_uploads_and_references_it(conv_cli, tmp_path):
    doc = tmp_path / "FLOWPAD-1431.md"
    doc.write_text("# research finding\nthe ticket was a dup", encoding="utf-8")
    payload = conv_cli.ok_payload(
        conv_cli.invoke(["conversation", "attach", conv_cli.conv_id, str(doc), "see attached"])
    )
    files = [a for a in payload["attachment"] if a.get("attachment_type") == "file"]
    assert files, payload["attachment"]
    assert files[0]["data"] == "data/FLOWPAD-1431.md"
    assert "see attached" in conv_cli.summary_text()


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_attach_entity_references_existing_entity(conv_cli):
    target = f"project-{conv_cli.project_id}"
    payload = conv_cli.ok_payload(
        conv_cli.invoke(["conversation", "attach", conv_cli.conv_id, target, "look at this project"])
    )
    type_ids = [a["data"] for a in payload["attachment"] if a.get("attachment_type") == "type_id"]
    assert target in type_ids


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_attach_missing_entity_fails_not_found(conv_cli):
    bogus = "skill-00000000-0000-4000-8000-000000000000"
    result = conv_cli.invoke(["conversation", "attach", conv_cli.conv_id, bogus, "nope"])
    assert result.exit_code == 4  # EXIT_NOT_FOUND


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_attach_missing_file_fails_invalid_arg(conv_cli):
    result = conv_cli.invoke(
        ["conversation", "attach", conv_cli.conv_id, "/no/such/file-here.md", "nope"]
    )
    assert result.exit_code == 2  # EXIT_INVALID_ARG


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_send_requires_nonempty_message(conv_cli):
    result = conv_cli.invoke(["conversation", "send", conv_cli.conv_id, "   "])
    assert result.exit_code == 2  # EXIT_INVALID_ARG
