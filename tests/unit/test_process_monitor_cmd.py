"""`flow process monitor` / `monitor-nudge` / `unmonitor` — the CLI commands themselves.

The server is faked at the HTTP boundary (``_common.local_request``), so these tests pin what each
command refuses, what it writes into the project and which calls it makes. They do NOT test the
automation engine: that the cron rule fires and runs the nudge is the trigger system's job.
Asking an agent is faked at ``process_cmd._ask`` (the streamed ``prompt`` action).
"""

from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import urlsplit

import pytest
from typer.testing import CliRunner

from flow_sdk.cli.commands import _common, process_cmd
from flow_sdk.schema.data_spec.trigger_spec import TriggerSpec

AP_ID = "11111111-1111-1111-1111-111111111111"
FORK_ID = "22222222-2222-2222-2222-222222222222"
PROJECT_ID = "33333333-3333-3333-3333-333333333333"
TRIGGER_ID = "44444444-4444-4444-4444-444444444444"
NAME = "tests-green"
KEY = f"{AP_ID}_monitor_{NAME}"
GOAL = "all unit tests under tests/unit pass"
STOP = "the same test failed 3 times in a row"
CRON = "*/10 * * * *"
VERDICTS = ("goal_met", "stop_condition_reached", "continue_to_work")


# ── the fake server ─────────────────────────────────────────────────────────


class _Response:
    def __init__(self, status_code: int, data=None, message: str = ""):
        self.status_code = status_code
        ok = status_code == 200
        self._body = {"status": "SUCCESS", "data": data} if ok else {"status": "FAIL", "message": message}
        self.text = json.dumps(self._body)

    def json(self):
        return self._body


class FakeFlowpad:
    """The local server, as far as these three commands talk to it, plus the agent they ask."""

    def __init__(self, project_dir: Path):
        self.process = {"id": AP_ID, "type": "agentic_process", "project_id": PROJECT_ID, "busy": False}
        self.project = {"id": PROJECT_ID, "type": "project", "fs_storage_mount_path": str(project_dir)}
        self.folder = project_dir / "agentic-assets" / "trigger" / KEY
        self.fork_refused = False
        self.calls: list[tuple[str, str, dict]] = []
        self.answers: list[str] = []
        self.asked: list[tuple[str, str]] = []
        self.folder_existed_at_delete: bool | None = None

    def request(self, method: str, url: str, **kwargs):
        path = urlsplit(url).path.split("/api/v1/graph/", 1)[1]
        body = kwargs.get("json") or kwargs.get("params") or {}
        self.calls.append((method, path, body))
        route = (method, path)
        if route == ("GET", f"agentic_process/{AP_ID}"):
            return _Response(200, self.process)
        if route == ("GET", f"project/{PROJECT_ID}"):
            return _Response(200, self.project)
        if route == ("POST", "compute_node/@local/fs-records/index"):
            return _Response(200, {"type": "trigger", "indexed": 1, "errors": 0, "typeids": [f"trigger-{TRIGGER_ID}"]})
        if route == ("PATCH", f"trigger/{TRIGGER_ID}"):
            return _Response(200, {"id": TRIGGER_ID, **body})
        if route == ("POST", f"trigger/{TRIGGER_ID}/cancel"):
            return _Response(200, {"status": "cancelled"})
        if route == ("DELETE", f"trigger/{TRIGGER_ID}"):
            self.folder_existed_at_delete = self.folder.exists()
            return _Response(200, {})
        if route == ("POST", f"agentic_process/{AP_ID}/fork"):
            if self.fork_refused:
                return _Response(500, message="claude_code does not support session forks")
            return _Response(200, {"id": FORK_ID, "type": "agentic_process"})
        if route == ("POST", f"agentic_process/{AP_ID}/enqueue"):
            return _Response(200, [body])
        return _Response(404, message=f"not found: {method} {path}")

    def ask(self, port: int, process_id: str, prompt: str) -> str:
        self.asked.append((process_id, prompt))
        return self.answers.pop(0)

    def posted(self, path: str) -> list[dict]:
        return [body for method, p, body in self.calls if method == "POST" and p == path]


@pytest.fixture
def flowpad(tmp_path, monkeypatch) -> FakeFlowpad:
    project_dir = tmp_path / "project"
    project_dir.mkdir()
    fake = FakeFlowpad(project_dir)
    monkeypatch.setattr(_common, "local_request", fake.request)
    monkeypatch.setattr(process_cmd, "_discover_port", lambda *a, **k: 4242)
    monkeypatch.setattr(process_cmd, "_ask", fake.ask)
    monkeypatch.setattr(process_cmd, "_state_dir", lambda: tmp_path / "state")
    return fake


@pytest.fixture
def monitored(flowpad) -> FakeFlowpad:
    """A monitor already set on the process; the calls that set it are forgotten."""
    result = _monitor()
    assert result.exit_code == 0, result.output
    flowpad.calls.clear()
    return flowpad


# ── the commands ────────────────────────────────────────────────────────────


def _run(*args: str):
    return CliRunner().invoke(process_cmd.process_app, list(args))


def monitor(*args: str):
    return _run("monitor", *args)


def nudge(key: str = KEY):
    return _run("monitor-nudge", key)


def unmonitor(key: str = KEY):
    return _run("unmonitor", key)


def _monitor(*extra: str, cron: str = CRON):
    """``monitor`` with every required input valid, plus ``extra``."""
    return monitor("-p", AP_ID, "--name", NAME, "--goal", GOAL, "--stop-condition", STOP, "--cron", cron, *extra)


def envelope(result) -> dict:
    """The last JSON line the command printed: ``ok`` on stdout, ``fail`` on stderr."""
    lines = [line for line in result.output.splitlines() if line.startswith("{")]
    assert lines, result.output
    return json.loads(lines[-1])


def refused(result, error_code: str) -> None:
    assert result.exit_code != 0, result.output
    assert envelope(result)["error_code"] == error_code, result.output


def _spec(flowpad: FakeFlowpad) -> TriggerSpec:
    return TriggerSpec.model_validate_json((flowpad.folder / "trigger.json").read_text(encoding="utf-8"))


def _reply(answer: str) -> str:
    return json.dumps({"answer": answer})


# ── monitor: bad input is refused before anything reaches the server ───────


def test_monitor_needs_a_goal_or_a_stop_condition(flowpad):
    refused(monitor("-p", AP_ID, "--name", NAME, "--cron", CRON), "MISSING_GOAL")
    assert flowpad.calls == []


def test_monitor_needs_a_name(flowpad):
    result = monitor("-p", AP_ID, "--goal", GOAL, "--cron", CRON)
    assert result.exit_code != 0
    assert "--name" in result.output  # not "No such command"
    assert flowpad.calls == []


@pytest.mark.parametrize("name", ["", "a/b", "a\\b", "..", "has space"])
def test_monitor_refuses_a_name_that_cannot_be_a_folder(flowpad, name):
    refused(monitor("-p", AP_ID, "--name", name, "--goal", GOAL, "--cron", CRON), "BAD_NAME")
    assert flowpad.calls == []


def test_monitor_needs_a_cron_mask(flowpad):
    result = monitor("-p", AP_ID, "--name", NAME, "--goal", GOAL)
    assert result.exit_code != 0
    assert "--cron" in result.output  # not "No such command"
    assert flowpad.calls == []


@pytest.mark.parametrize("mask", ["every ten minutes", "61 * * * *", "* * *"])
def test_a_bad_cron_mask_is_refused(flowpad, mask):
    refused(_monitor(cron=mask), "BAD_CRON")
    assert flowpad.calls == []


# ── monitor: bad state ──────────────────────────────────────────────────────


def test_monitor_refuses_a_process_that_does_not_exist(flowpad):
    other = "99999999-9999-9999-9999-999999999999"
    refused(monitor("-p", other, "--name", NAME, "--goal", GOAL, "--cron", CRON), "NOT_FOUND")
    assert not flowpad.folder.parent.exists()


def test_monitor_refuses_a_project_with_no_folder(flowpad):
    flowpad.project["fs_storage_mount_path"] = None
    refused(_monitor(), "NO_PROJECT_FOLDER")


def test_monitor_refuses_a_name_the_process_is_already_monitored_by(monitored):
    refused(_monitor(), "ALREADY_MONITORED")


# ── monitor: what it writes ─────────────────────────────────────────────────


def test_a_monitor_is_a_cron_schedule_that_runs_the_nudge(flowpad):
    result = _monitor()
    assert result.exit_code == 0, result.output
    spec = _spec(flowpad)
    assert spec.schedule is not None
    assert (spec.schedule.every, spec.schedule.expr) == ("cron", CRON)
    assert spec.then is not None and spec.then.run_script == f"flow process monitor-nudge {KEY}"
    # One machine's session: nothing for a clone of the project to switch on.
    assert spec.recommended is False


def test_monitor_keeps_the_goal_for_the_nudge(flowpad):
    assert _monitor().exit_code == 0
    saved = json.loads((flowpad.folder / "monitor.json").read_text(encoding="utf-8"))
    assert (saved["process_id"], saved["goal"], saved["stop_condition"]) == (AP_ID, GOAL, STOP)


def test_monitor_indexes_the_rule_and_switches_it_on(flowpad):
    result = _monitor()
    assert result.exit_code == 0, result.output
    indexed = flowpad.posted("compute_node/@local/fs-records/index")
    assert indexed and Path(indexed[-1]["path"]).resolve() == flowpad.folder.resolve()
    # A rule indexed from a project file starts off and undecided (docs/automations.md, "On, off and recommended").
    assert ("PATCH", f"trigger/{TRIGGER_ID}", {"enabled": True}) in flowpad.calls
    assert envelope(result)["key"] == KEY


# ── nudge ───────────────────────────────────────────────────────────────────


def test_nudge_skips_a_busy_process(monitored):
    monitored.process["busy"] = True
    result = nudge()
    assert result.exit_code == 0, result.output
    assert monitored.asked == []
    assert monitored.posted(f"agentic_process/{AP_ID}/fork") == []


def test_nudge_asks_a_headless_fork_not_the_session(monitored):
    monitored.answers = [_reply("continue_to_work")]
    assert nudge().exit_code == 0
    assert monitored.posted(f"agentic_process/{AP_ID}/fork") == [{"headless": True}]
    assert [pid for pid, _ in monitored.asked] == [FORK_ID]
    question = monitored.asked[0][1]
    assert GOAL in question and STOP in question
    assert "You are the fork" in question
    assert all(verdict in question for verdict in VERDICTS)


def test_continue_to_work_prompts_the_session_to_go_on(monitored):
    monitored.answers = [_reply("continue_to_work")]
    result = nudge()
    assert result.exit_code == 0, result.output
    prompts = [body["prompt"] for body in monitored.posted(f"agentic_process/{AP_ID}/enqueue")]
    assert len(prompts) == 1
    assert GOAL in prompts[0] and STOP in prompts[0]
    assert monitored.folder.exists()  # still monitoring


@pytest.mark.parametrize("verdict", ["goal_met", "stop_condition_reached"])
def test_a_met_goal_or_a_reached_stop_ends_the_monitor_and_tells_no_one(monitored, verdict):
    monitored.answers = [_reply(verdict)]
    result = nudge()
    assert result.exit_code == 0, result.output
    assert not monitored.folder.exists()
    assert ("DELETE", f"trigger/{TRIGGER_ID}", {}) in monitored.calls
    assert monitored.posted(f"agentic_process/{AP_ID}/enqueue") == []


def test_an_invalid_answer_is_asked_again_on_the_same_fork(monitored):
    monitored.answers = ["sure, looks good", _reply("continue_to_work")]
    assert nudge().exit_code == 0
    assert [pid for pid, _ in monitored.asked] == [FORK_ID, FORK_ID]
    retry = monitored.asked[1][1]
    assert "invalid" in retry.lower()
    assert "Invalid JSON" in retry  # pydantic's own error, handed back
    assert len(monitored.posted(f"agentic_process/{AP_ID}/enqueue")) == 1


@pytest.mark.parametrize(
    "bad",
    [
        "sure, looks good",
        json.dumps({"answer": "maybe"}),
        json.dumps({"answer": "goal_met", "why": "all green"}),
    ],
    ids=["prose", "unknown-answer", "extra-field"],
)
def test_after_three_retries_the_nudge_fails_and_changes_nothing(monitored, bad):
    monitored.answers = [bad] * 4
    refused(nudge(), "INVALID_ANSWER")
    assert len(monitored.asked) == 4  # the first ask and three retries
    assert monitored.posted(f"agentic_process/{AP_ID}/enqueue") == []
    assert monitored.folder.exists()


def test_a_session_that_cannot_fork_is_asked_itself(monitored):
    monitored.fork_refused = True
    monitored.answers = [_reply("continue_to_work")]
    result = nudge()
    assert result.exit_code == 0, result.output
    assert [pid for pid, _ in monitored.asked] == [AP_ID]
    assert "fork" not in monitored.asked[0][1]


def test_nudge_skips_while_another_check_runs(monitored, tmp_path):
    (tmp_path / "state").mkdir()
    (tmp_path / "state" / f"{KEY}.lock").touch()
    result = nudge()
    assert result.exit_code == 0, result.output
    assert "skipped" in envelope(result)
    assert monitored.asked == []


# ── unmonitor ───────────────────────────────────────────────────────────────


def test_unmonitor_removes_the_folder_then_the_row(monitored):
    result = unmonitor()
    assert result.exit_code == 0, result.output
    assert not monitored.folder.exists()
    assert ("DELETE", f"trigger/{TRIGGER_ID}", {}) in monitored.calls
    # The indexer resurrects a row whose folder is still on disk (agent_schedule.remove_schedule).
    assert monitored.folder_existed_at_delete is False


@pytest.mark.parametrize("command", [nudge, unmonitor], ids=["nudge", "unmonitor"])
def test_an_unknown_monitor_is_not_found(flowpad, command):
    refused(command(f"{AP_ID}_monitor_nope"), "NOT_FOUND")
