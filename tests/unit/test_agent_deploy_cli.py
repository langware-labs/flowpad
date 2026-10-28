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
ACTIVITY = {"path": "deploy", "subject_entity": f"agent-{AGENT_ID}"}
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
        if payload.get("provider") == "local":
            return {"agent_id": AGENT_ID, "deployment": {"id": "d-local"}}
        return {"agent_id": AGENT_ID, "activity": ACTIVITY, "deployment_id": "d-1"}

    monkeypatch.setattr(agent_cmd, "discover_port", lambda required=True: 1)
    monkeypatch.setattr(agent_cmd, "get_graph_json", get)
    monkeypatch.setattr(agent_cmd, "post_graph_json", post)
    return calls, state


def test_deploys_an_agent_named_by_its_name(app):
    calls, _ = app

    result = CliRunner().invoke(flow_cli.app, ["agent", "deploy", "researcher", "--environment", "staging", "--no-blocking"])

    assert result.exit_code == 0, result.stdout
    assert json.loads(result.stdout) == {"ok": True, "agent_id": AGENT_ID, "activity": ACTIVITY, "deployment_id": "d-1"}
    assert calls[-1][1].endswith(f"/agent/{AGENT_ID}/deploy")
    assert calls[-1][2] == {"environment": "staging", "provider": "e2b"}


def test_deploys_on_the_provider_named_by_provider(app):
    calls, _ = app

    result = CliRunner().invoke(flow_cli.app, ["agent", "deploy", AGENT_ID, "--provider", "gcp_vm", "--no-blocking"])

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


def _report(state: str, steps: dict[str, str], message: str | None = None) -> dict:
    """The frame the app sends a watcher of the agent each time its deploy activity changes."""
    return {"message_type": "flow_data_msg", "to_entity": f"agent-{AGENT_ID}",
            "flow_data": {"element_type": "progress_report",
                          "attributes": {"path": "deploy", "state": state, "message": message,
                                         "children": [{"name": n, "state": st} for n, st in steps.items()]}}}


class _Frames(list):
    """The frames the app sends; and the connection ids the command opened its socket under."""

    def __init__(self) -> None:
        super().__init__()
        self.connection_ids: list[str] = []


@pytest.fixture
def frames(app, monkeypatch):
    """The socket double: the app's frames, sent once the command has registered its watch and sent the deploy."""
    sent = _Frames()

    async def backend_frames(port, kinds, *, on_connected=None, connection_id=None):
        sent.connection_ids.append(connection_id)
        await on_connected()
        for frame in sent:
            yield frame

    monkeypatch.setattr(agent_cmd, "backend_frames", backend_frames)
    return sent


def test_a_blocking_deploy_prints_each_report_of_the_agent_until_it_completes(app, frames):
    calls, _ = app
    frames += [
        _report("running", {"publish": "running"}),
        {**_report("running", {}), "to_entity": "agent-someone-else"},
        _report("completed", {"publish": "completed", "machine": "completed"}),
    ]

    result = CliRunner().invoke(flow_cli.app, ["agent", "deploy", AGENT_ID])

    assert result.exit_code == 0, result.output
    lines = [json.loads(line) for line in result.stdout.splitlines()]
    assert [(line["state"], line["steps"]) for line in lines] == [
        ("running", {"publish": "running"}),
        ("completed", {"publish": "completed", "machine": "completed"}),
    ]
    assert [(c[0], c[1].rsplit("/", 1)[-1]) for c in calls] == [("POST", "watch"), ("POST", "deploy")], "watched first"


def test_a_blocking_deploy_that_fails_exits_1_with_the_reason(app, frames):
    frames += [
        _report("running", {"readiness": "running"}),
        _report("failed", {"readiness": "failed"}, "not ready to deploy: stripe missing"),
    ]

    result = CliRunner().invoke(flow_cli.app, ["agent", "deploy", AGENT_ID])

    assert result.exit_code == int(ExitCode.NOT_YET)
    assert "DEPLOY_FAILED" in result.output and "stripe missing" in result.output


@pytest.mark.parametrize("ended", ["cancelled", "interrupted"])
def test_a_blocking_deploy_that_is_cut_short_exits_1(app, frames, ended):
    frames += [_report("running", {"machine": "running"}), _report(ended, {"machine": ended})]

    result = CliRunner().invoke(flow_cli.app, ["agent", "deploy", AGENT_ID])

    assert result.exit_code == int(ExitCode.NOT_YET)
    assert "DEPLOY_FAILED" in result.output and ended in result.output


def test_a_connection_that_closes_before_the_deploy_ends_is_not_a_success(app, frames):
    frames += [_report("running", {"machine": "running"})]

    result = CliRunner().invoke(flow_cli.app, ["agent", "deploy", AGENT_ID])

    assert result.exit_code == int(ExitCode.NOT_YET)
    assert "DEPLOY_NOT_FINISHED" in result.output


def test_only_the_deploy_reports_of_the_agent_are_printed(app, frames):
    other_activity = _report("running", {"a": "running"})
    other_activity["flow_data"]["attributes"]["path"] = "setup"
    not_a_report = _report("running", {"a": "running"})
    not_a_report["flow_data"]["element_type"] = "something_else"
    frames += [other_activity, not_a_report, _report("completed", {"machine": "completed"})]

    result = CliRunner().invoke(flow_cli.app, ["agent", "deploy", AGENT_ID])

    assert result.exit_code == 0, result.output
    assert [json.loads(line)["state"] for line in result.stdout.splitlines()] == ["completed"]


def test_the_watch_is_registered_for_the_connection_the_deploy_is_followed_on(app, frames):
    calls, _ = app
    frames += [_report("completed", {})]

    CliRunner().invoke(flow_cli.app, ["agent", "deploy", AGENT_ID])

    (connection_id,) = frames.connection_ids
    assert calls[0][1].endswith(f"/agent/{AGENT_ID}/watch") and calls[0][2] == {"connection_id": connection_id}


def test_no_blocking_opens_no_connection(app, monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("--no-blocking must not open the socket")

    monkeypatch.setattr(agent_cmd, "backend_frames", refuse)

    result = CliRunner().invoke(flow_cli.app, ["agent", "deploy", AGENT_ID, "--no-blocking"])

    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout) == {"ok": True, "agent_id": AGENT_ID, "activity": ACTIVITY, "deployment_id": "d-1"}


def test_a_local_deploy_has_nothing_to_follow_and_never_blocks(app, monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("--provider local has no deploy activity: it must not wait on the socket")

    monkeypatch.setattr(agent_cmd, "backend_frames", refuse)

    result = CliRunner().invoke(flow_cli.app, ["agent", "deploy", AGENT_ID, "--provider", "local"])

    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout) == {"ok": True, "agent_id": AGENT_ID, "activity": None, "deployment_id": "d-local"}


def test_a_refusal_from_the_app_exits_1_before_any_report_is_printed(app, frames):
    _, state = app
    state["ready"] = False

    result = CliRunner().invoke(flow_cli.app, ["agent", "deploy", AGENT_ID])

    assert result.exit_code == 1 and "not_ready" in result.output
    assert "state" not in result.stdout


def test_an_unknown_name_is_not_found(app):
    result = CliRunner().invoke(flow_cli.app, ["agent", "deploy", "nobody"])

    assert result.exit_code == 4
