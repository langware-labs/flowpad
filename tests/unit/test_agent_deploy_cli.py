"""``flow agent deploy``: resolves the agent by name, deploys through the running app, and a readiness
refusal exits 1 naming each missing item and the deployment — nothing deployed. The app is a double."""
from __future__ import annotations

import json

import pytest
from typer.testing import CliRunner

from flow_sdk.cli import flow_cli
from flow_sdk.cli.commands import agent_cmd
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

AGENT_ID = "0b1c9a2e-5f4d-4c3b-9a8e-7d6c5b4a3f21"
READINESS = {"agent_id": AGENT_ID, "deployment_id": "d-1", "environment": "production", "ready": False,
             "items": [{"requirement": {"kind": "credential", "name": "stripe"}, "status": "missing",
                        "fix": "flow credentials set stripe --stdin"}]}


@pytest.fixture
def app(monkeypatch):
    calls: list[tuple[str, str, dict]] = []
    state = {"ready": True}

    def get(url, *, params=None, on_error, **_):
        calls.append(("GET", url, params or {}))
        if url.endswith("/deployment/providers"):
            if state.get("signed_out"):
                on_error(409, {"status": "FAIL", "message": "Sign in to the hub to deploy to the cloud"})
            return ["e2b", "gcp_vm"]
        return [{"id": AGENT_ID, "name": "researcher"}] if json.loads(params["filter"]) == {"name": "researcher"} else []

    def post(url, payload, *, on_error, **_):
        calls.append(("POST", url, payload))
        if not state["ready"]:
            on_error(409, {"status": "FAIL", "message": "not ready to deploy: stripe missing",
                           "data": {"code": "not_ready", "readiness": READINESS}})
        return {"agent_id": AGENT_ID, "deployment": {"id": "d-1"}, "secrets": {"placed": ["STRIPE_KEY"], "failed": []}}

    monkeypatch.setattr(agent_cmd, "discover_port", lambda required=True: 1)
    monkeypatch.setattr(agent_cmd, "get_graph_json", get)
    monkeypatch.setattr(agent_cmd, "post_graph_json", post)
    return calls, state


def test_deploys_an_agent_named_by_its_name(app):
    calls, _ = app

    result = CliRunner().invoke(flow_cli.app, ["agent", "deploy", "researcher", "--environment", "staging"])

    assert result.exit_code == 0, result.stdout
    assert json.loads(result.stdout) == {"ok": True, "agent_id": AGENT_ID, "deployment_id": "d-1",
                                         "secrets": {"placed": ["STRIPE_KEY"], "failed": []}}
    assert calls[-1][1].endswith(f"/agent/{AGENT_ID}/deploy") and calls[-1][2] == {"environment": "staging", "provider": "e2b"}


def test_deploys_on_the_provider_named_by_provider(app):
    calls, _ = app

    result = CliRunner().invoke(flow_cli.app, ["agent", "deploy", AGENT_ID, "--provider", "gcp_vm"])

    assert result.exit_code == 0, result.stdout
    assert calls[-1][2] == {"environment": None, "provider": "gcp_vm"}


def test_lists_the_providers_the_hub_offers(app):
    calls, _ = app

    result = CliRunner().invoke(flow_cli.app, ["agent", "providers"])

    assert result.exit_code == 0, result.stdout
    assert json.loads(result.stdout) == {"ok": True, "providers": ["e2b", "gcp_vm"]}
    assert calls[-1][1].endswith("/deployment/providers")


def test_providers_while_signed_out_is_refused(app):
    _, state = app
    state["signed_out"] = True

    result = CliRunner().invoke(flow_cli.app, ["agent", "providers"])

    assert result.exit_code == int(ExitCode.REFUSED)
    assert "Sign in to the hub" in result.output


def test_a_readiness_refusal_exits_1_with_what_is_missing(app):
    calls, state = app
    state["ready"] = False

    result = CliRunner().invoke(flow_cli.app, ["agent", "deploy", AGENT_ID])

    assert result.exit_code == 1
    assert "not_ready" in result.output and "flow credentials set stripe --stdin" in result.output
    assert [c[0] for c in calls] == ["POST"], "an id is not looked up"


def test_an_unknown_name_is_not_found(app):
    result = CliRunner().invoke(flow_cli.app, ["agent", "deploy", "nobody"])

    assert result.exit_code == 4
