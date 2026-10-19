"""``flow test run`` — a test command's progress, read off the runner, onto an activity.

The pure parts (reporter injection, the tally, the verdict) are pinned directly. One
end-to-end test runs a REAL pytest subprocess with the shipped plugin against the real
activity route (HTTP stubbed onto the in-process ASGI app), because the thing that breaks
in a bridge is the hop between the runner and the counts.
"""

from __future__ import annotations

import asyncio
import json
import sys
import textwrap

import pytest
from httpx import ASGITransport, AsyncClient
from typer.testing import CliRunner

from flow_sdk.activity import Activity, monitor
from flow_sdk.cli.commands import progress_cmd, test_cmd
from flow_sdk.cli.commands.test_cmd import Tally, verdict_of, with_reporter
from flow_sdk.cli.flow_cli import app
from flow_sdk.server.app import app as server_app

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

runner = CliRunner()


@pytest.fixture(autouse=True)
def _clean_monitor(monkeypatch):
    monkeypatch.setattr("flow_sdk.utils.environment.get_execution_scope", lambda: [])
    monitor.clear()
    yield
    monitor.clear()


@pytest.fixture()
def wired(monkeypatch):
    """The CLI's HTTP helpers, pointed at the real route in-process."""
    def request(method, url, **kwargs):
        kwargs.pop("timeout", None)

        async def go():
            async with AsyncClient(transport=ASGITransport(app=server_app), base_url="http://test") as c:
                return await c.request(method, url.split("localhost:9999", 1)[-1], **kwargs)

        return asyncio.run(go())

    monkeypatch.setattr(progress_cmd, "_local_post", lambda url, **kw: request("POST", url, **kw))
    monkeypatch.setattr(progress_cmd, "_local_get", lambda url, **kw: request("GET", url, **kw))
    monkeypatch.setattr("flow_sdk.cli.commands._common.discover_port", lambda: 9999)


# ---------------------------------------------------------------- reporter injection


@pytest.mark.parametrize("cmd, expected", [
    (["uv", "run", "pytest", "tests/a.py"], ["uv", "run", "pytest", "-p", test_cmd.PYTEST_PLUGIN, "tests/a.py"]),
    (["python", "-m", "pytest", "-q"], ["python", "-m", "pytest", "-p", test_cmd.PYTEST_PLUGIN, "-q"]),
    (["npx", "vitest", "run", "--project", "api"],
     ["npx", "vitest", "run", "--project", "api", "--reporter=default", f"--reporter={test_cmd.VITEST_REPORTER}"]),
    (["go", "test", "./..."], ["go", "test", "./..."]),
])
def test_the_runner_gets_its_reporter(cmd, expected):
    assert with_reporter(cmd) == expected


@pytest.mark.parametrize("cmd, name", [
    (["uv", "run", "--project", "/abs/repo", "pytest", "-q"], "pytest"),
    (["npx", "vitest", "run"], "vitest"),
    (["/usr/bin/make", "test"], "make"),
])
def test_the_running_message_names_the_runner_not_the_argv(cmd, name):
    assert test_cmd.runner_name(cmd) == name


def test_the_shipped_vitest_reporter_exists():
    assert test_cmd.VITEST_REPORTER.is_file()


# ---------------------------------------------------------------- tally + verdict


def _tally(*events):
    tally = Tally()
    for event in events:
        tally.feed(event)
    return tally


def test_the_tally_counts_outcomes_and_keeps_each_failure():
    tally = _tally(
        {"event": "collected", "n": 3},
        {"event": "result", "id": "a", "outcome": "passed"},
        {"event": "result", "id": "b", "outcome": "failed", "message": "boom"},
        {"event": "result", "id": "c", "outcome": "skipped"},
    )

    assert (tally.collected, tally.count("passed"), tally.count("skipped")) == (3, 1, 1)
    assert tally.failures == [{"id": "b", "message": "boom"}]


def test_a_teardown_failure_turns_a_passed_test_red_once():
    tally = _tally(
        {"event": "result", "id": "a", "outcome": "passed"},
        {"event": "result", "id": "a", "outcome": "failed", "message": "teardown: x", "amend": True},
    )

    assert tally.count("failed") == 1 and tally.count("passed") == 0


@pytest.mark.parametrize("exit_code, events, planned, verdict", [
    (0, [{"event": "collected", "n": 2}, {"event": "result", "id": "a", "outcome": "passed"},
         {"event": "result", "id": "b", "outcome": "passed"}], 2, "PASS"),
    (1, [{"event": "collected", "n": 2}, {"event": "result", "id": "a", "outcome": "failed"}], 2, "RED"),
    (5, [], None, "NO_VERDICT"),
    (0, [{"event": "collected", "n": 5}], 2, "MISMATCH"),
])
def test_the_exit_code_decides_and_the_tally_explains(exit_code, events, planned, verdict):
    assert verdict_of(exit_code, _tally(*events), planned)[0] == verdict


# ---------------------------------------------------------------- end to end


def test_a_real_pytest_run_reports_live_counts_and_its_verdict(wired, tmp_path):
    (tmp_path / "test_demo.py").write_text(textwrap.dedent("""
        import pytest

        def test_one(): pass
        def test_two(): assert 1 == 2, "two is not one"
        @pytest.mark.skip(reason="not today")
        def test_three(): pass
    """))
    Activity.get("qa").plan([{"name": "p02", "label": "pytest demo", "total": 3}])

    result = runner.invoke(app, [
        "test", "run", "--activity", "qa/p02", "--cwd", str(tmp_path),
        "--", sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "test_demo.py",
    ])

    summary = json.loads(result.output.strip().splitlines()[-1])
    assert result.exit_code == test_cmd.EXIT_RED, result.output
    assert (summary["verdict"], summary["collected"], summary["passed"], summary["skipped"]) == ("RED", 3, 1, 1)
    assert summary["failures"][0]["id"] == "test_demo.py::test_two"

    phase = monitor.get("qa").children[0]
    assert (phase.state, phase.total, phase.done, phase.skipped, phase.errors_count) == ("blocked", 3, 2, 1, 1)
    assert phase.errors[0].ref == "test_demo.py::test_two"
    assert phase.message == "1 failing · 1 passed"
    assert phase.current is None, "the run is over: nothing is in hand"
