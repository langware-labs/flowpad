"""``flow conversation guest``: the support agent's one way to write to a ticket's team side; ``team`` points a
deployed agent there instead of letting it write free text."""

from __future__ import annotations

import json
import uuid

import pytest
from typer.testing import CliRunner

from flow_sdk.cli.commands import conversation_cmd
from flow_sdk.cli.flow_cli import app

pytestmark = [pytest.mark.timeout(30)]  # do not increase timeout without approval

runner = CliRunner()
TICKET = str(uuid.uuid4())


@pytest.fixture(autouse=True)
def signed_in_server(monkeypatch):
    monkeypatch.setattr(conversation_cmd, "_discover_port", lambda: 8123)
    monkeypatch.setattr(conversation_cmd, "_signed_in", lambda: True)


def test_guest_posts_the_text_to_the_ticket_and_answers_its_status(monkeypatch):
    posted = {}

    def post_json(url, payload, **_kw):
        posted.update(url=url, payload=payload)
        return {"id": "gm-1", "message_id": "m-1", "status": "pending", "extra": "dropped"}

    monkeypatch.setattr(conversation_cmd, "_post_json", post_json)

    result = runner.invoke(app, ["conversation", "guest", TICKET, "Her invoices page is empty."])

    assert result.exit_code == 0, result.output
    assert posted["url"].endswith(f"/conversation/{TICKET}/guest_message")
    assert posted["payload"] == {"text": "Her invoices page is empty."}
    assert json.loads(result.output)["status"] == "pending"


def test_a_deployed_agent_is_pointed_from_team_to_guest(monkeypatch):
    monkeypatch.setattr(conversation_cmd, "_is_deployed_agent_process", lambda port: True)
    monkeypatch.setattr(conversation_cmd, "_post_json", lambda *a, **k: pytest.fail("must not reach the hub"))

    result = runner.invoke(app, ["conversation", "team", TICKET, "hello team"])

    assert result.exit_code != 0
    assert f"flow conversation guest {TICKET}" in result.output
