"""``flow progress`` — the shell and agent face of the activity mechanism.

Runs the real command against the real route, with only the HTTP hop stubbed onto an
in-process ASGI client. That keeps the test fast while still proving the thing that
actually breaks in a CLI: whether the words a person types land as the right verb and
the right argument on the other side.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from httpx import ASGITransport, AsyncClient
from typer.testing import CliRunner

from flow_sdk.activity import Activity, monitor
from flow_sdk.cli.commands import progress_cmd
from flow_sdk.cli.flow_cli import app
from flow_sdk.server.app import app as server_app

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

runner = CliRunner()


@pytest.fixture(autouse=True)
def _clean_monitor():
    monitor.clear()
    yield
    monitor.clear()


@pytest.fixture(autouse=True)
def _wire_to_the_real_route(monkeypatch):
    """Point the CLI's HTTP helpers at the ASGI app instead of a live port.

    The CLI's job is turning words into a request; the route's job is the rest. Stubbing
    at the transport keeps both real and needs no server process — and it means a change
    to the route's contract fails HERE too, which is the point of testing the pair.
    """
    def request(method, url, **kwargs):
        kwargs.pop("timeout", None)

        async def go():
            async with AsyncClient(transport=ASGITransport(app=server_app), base_url="http://test") as c:
                return await c.request(method, _path(url), **kwargs)

        # One loop per call: the CLI is synchronous, and the ASGI transport is not. The
        # monitor is a module global, so state carries across calls the way it does in
        # production.
        return asyncio.run(go())

    monkeypatch.setattr(progress_cmd, "_local_post", lambda url, **kw: request("POST", url, **kw))
    monkeypatch.setattr(progress_cmd, "_local_get", lambda url, **kw: request("GET", url, **kw))
    monkeypatch.setattr("flow_sdk.cli.commands._common.discover_port", lambda: 9999)
    yield


def _path(url: str) -> str:
    return url.split("localhost:9999", 1)[-1]


def run(*args):
    result = runner.invoke(app, ["progress", *args])
    assert result.exit_code == 0, result.output
    return json.loads(result.output.strip().splitlines()[-1])


def run_failing(*args):
    result = runner.invoke(app, ["progress", *args])
    assert result.exit_code != 0, f"expected a refusal, got: {result.output}"
    for line in reversed(result.output.strip().splitlines()):
        if line.startswith("{"):
            return json.loads(line)
    raise AssertionError(f"no error envelope in: {result.output}")


# ---------------------------------------------------------------- registration


def test_the_command_is_registered():
    result = runner.invoke(app, ["progress", "--help"])

    assert result.exit_code == 0
    for sub in ("report", "show", "list"):
        assert sub in result.output


# ---------------------------------------------------------------- verbs


def test_report_creates_and_counts():
    payload = run("report", "index", "inc-success")

    assert payload["ok"] is True
    assert payload["activity"]["done"] == 1
    assert monitor.get("index").done == 1


@pytest.mark.parametrize("spelling", ["inc-success", "incSuccess", "inc_success"])
def test_every_spelling_of_a_verb_works_from_a_shell(spelling):
    """A person types kebab, a script may paste camel from the TS side. One vocabulary."""
    assert run("report", "index", spelling)["activity"]["done"] == 1


def test_a_value_verb_takes_its_argument_as_a_value():
    run("report", "index", "total", "5000")
    payload = run("report", "index", "current", "~/notes/q3.md")

    assert payload["activity"]["total"] == 5000
    assert payload["activity"]["current"] == "~/notes/q3.md"


def test_a_lifecycle_verb_takes_its_argument_as_a_message():
    """``done "indexed 5,000"`` reads the way a person says it, so the argument has to
    land as the message rather than as some value nobody asked for."""
    run("report", "index", "inc-success")
    payload = run("report", "index", "done", "indexed 5,000")

    assert payload["activity"]["state"] == "completed"
    assert payload["activity"]["message"] == "indexed 5,000"


def test_inc_error_takes_a_message_and_a_ref():
    payload = run("report", "index", "inc-error", "encrypted", "--ref", "a.pdf", "--code", "E_ENC")

    spec = payload["activity"]
    assert (spec["errors_count"], spec["done"]) == (1, 0)
    assert (spec["errors"][0]["ref"], spec["errors"][0]["code"]) == ("a.pdf", "E_ENC")


def test_inc_names_a_counter():
    payload = run("report", "index", "inc", "--counter", "orphans", "--n", "17")

    assert payload["activity"]["counters"] == {"orphans": 17}


def test_the_n_option_repeats_an_increment():
    assert run("report", "index", "inc-skipped", "--n", "40")["activity"]["skipped"] == 40


def test_a_bare_verb_needs_no_argument():
    run("report", "index", "inc-success")
    run("report", "index", "block", "waiting")

    assert run("report", "index", "resume")["activity"]["state"] == "running"


def test_a_deep_address_reports_on_a_child():
    run("report", "index/pdf", "inc-success")

    assert monitor.get("index").children[0].name == "pdf"


# ---------------------------------------------------------------- stdin


def test_stdin_applies_a_stream_of_verbs_in_order(monkeypatch):
    """One process for a whole loop. Spawning `flow` ten thousand times to walk ten
    thousand files is the reason this option exists."""
    lines = "\n".join(f"current file-{i}.md\ninc-success" for i in range(5))

    result = runner.invoke(app, ["progress", "report", "walk", "--stdin"], input=lines)

    assert result.exit_code == 0, result.output
    spec = monitor.get("walk")
    assert spec.done == 5
    assert spec.current == "file-4.md", "the last line applied is the state left behind"


def test_stdin_ignores_blank_lines():
    result = runner.invoke(app, ["progress", "report", "walk", "--stdin"], input="inc-success\n\n\ninc-success\n")

    assert result.exit_code == 0, result.output
    assert monitor.get("walk").done == 2


# ---------------------------------------------------------------- reading


def test_show_prints_one_tree():
    Activity.get("index").total(10).inc_success()

    payload = run("show", "index")

    assert payload["activity"]["path"] == "index"
    assert payload["activity"]["done"] == 1


def test_list_prints_live_roots():
    Activity.get("index").inc_success()
    Activity.get("qa").inc_success()

    payload = run("list")

    assert sorted(a["path"] for a in payload["activities"]) == ["index", "qa"]


def test_a_finished_activity_is_gone_from_list():
    Activity.get("index").inc_success()
    run("report", "index", "done")

    assert run("list")["activities"] == []


# ---------------------------------------------------------------- refusals


def test_an_unknown_verb_exits_non_zero_with_a_parseable_code():
    """An agent must be able to act on a refusal without scraping the prose."""
    envelope = run_failing("report", "index", "explode")

    assert envelope["ok"] is False
    assert envelope["error_code"] == "UNKNOWN_VERB"


def test_show_on_a_missing_activity_refuses_with_not_live():
    assert run_failing("show", "nothing-here")["error_code"] == "NOT_LIVE"


def test_a_missing_verb_is_refused_before_any_request():
    assert run_failing("report", "index")["error_code"] == "NO_VERB"
    assert monitor.count() == 0, "a malformed command must not mint a phantom row"


# ---------------------------------------------------------------- scope


def test_scope_defaults_to_the_calling_agentic_process(monkeypatch):
    """An agent reporting its own progress should not have to know its own id."""
    monkeypatch.setattr(
        "flow_sdk.utils.environment.get_execution_scope",
        lambda: [{"type": "agentic_process", "id": "abc"}],
    )

    run("report", "run", "inc-success")

    assert monitor.get("run") is None, "it did not land on the instance-wide address"
    assert monitor.get("run", scope="agentic_process-abc").done == 1


def test_an_explicit_scope_wins(monkeypatch):
    monkeypatch.setattr(
        "flow_sdk.utils.environment.get_execution_scope",
        lambda: [{"type": "agentic_process", "id": "abc"}],
    )

    run("report", "run", "inc-success", "--scope", "data_source-xyz")

    assert monitor.get("run", scope="data_source-xyz").done == 1


def test_a_plain_shell_reports_to_the_instance_scope(monkeypatch):
    monkeypatch.setattr("flow_sdk.utils.environment.get_execution_scope", lambda: [])

    run("report", "index", "inc-success")

    assert monitor.get("index").done == 1
