"""`flow process monitor` / `monitor-nudge` / `unmonitor` — the CLI commands themselves.

The server is faked at the HTTP boundary (``_common.local_request``), so these tests pin what each
command refuses, what it writes into the project and which calls it makes. They do NOT test the
automation engine: that the cron rule fires and runs the nudge is the trigger system's job.
The nudge forks and asks in its own process, through the SDK: faked at ``process_monitor_cmd._fork`` and
``process_monitor_cmd._ask``.
"""

from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import urlsplit

import pytest
from typer.testing import CliRunner

from flow_sdk.cli.commands import _common, process_cmd, process_monitor_cmd
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
        self.drained = False

    def json(self):
        return self._body

    def iter_content(self, chunk_size=None):
        self.drained = True
        yield b"data: <flow/>\n\n"

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeFlowpad:
    """The local server, as far as these three commands talk to it, plus the agent they ask."""

    def __init__(self, project_dir: Path):
        self.process = {"id": AP_ID, "type": "agentic_process", "project_id": PROJECT_ID, "busy": False}
        self.project = {"id": PROJECT_ID, "type": "project", "fs_storage_mount_path": str(project_dir)}
        self.folder = project_dir / "agentic-assets" / "trigger" / KEY
        self.fork_refused = False
        self.prompt_refused = False
        self.forked: list[str] = []
        self.prompt_responses: list[_Response] = []
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
        if route == ("POST", f"agentic_process/{AP_ID}/prompt"):
            response = _Response(409, message="another prompt turn is already in flight for this process") \
                if self.prompt_refused else _Response(200)
            self.prompt_responses.append(response)
            return response
        return _Response(404, message=f"not found: {method} {path}")

    async def fork(self, process_id: str):
        self.forked.append(process_id)
        return None if self.fork_refused else FORK_ID

    async def ask(self, process_id: str, prompt: str) -> str:
        self.asked.append((process_id, prompt))
        return self.answers.pop(0)

    def prompted(self) -> list[str]:
        """What the session was sent through its ``prompt`` action."""
        return [body["message"] for body in self.posted(f"agentic_process/{AP_ID}/prompt")]

    def posted(self, path: str) -> list[dict]:
        return [body for method, p, body in self.calls if method == "POST" and p == path]


@pytest.fixture
def flowpad(tmp_path, monkeypatch) -> FakeFlowpad:
    project_dir = tmp_path / "project"
    project_dir.mkdir()
    fake = FakeFlowpad(project_dir)
    monkeypatch.setattr(_common, "local_request", fake.request)
    monkeypatch.setattr(process_monitor_cmd, "discover_port", lambda *a, **k: 4242)
    monkeypatch.setattr(process_monitor_cmd, "_fork", fake.fork)
    monkeypatch.setattr(process_monitor_cmd, "_ask", fake.ask)
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


def test_a_mask_the_server_accepts_is_accepted(flowpad):
    """Sunday as 7: the server's own check (``spec_file.validate``) reads it; a bare CronTrigger does not."""
    result = _monitor(cron="0 9 * * 7")
    assert result.exit_code == 0, result.output
    assert _spec(flowpad).schedule.expr == "0 9 * * 7"


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
    assert monitored.forked == [] and monitored.asked == []
    assert monitored.prompted() == []


def test_nudge_asks_a_fork_not_the_session(monitored):
    monitored.answers = [_reply("continue_to_work")]
    assert nudge().exit_code == 0
    assert monitored.forked == [AP_ID]
    assert [pid for pid, _ in monitored.asked] == [FORK_ID]
    question = monitored.asked[0][1]
    assert GOAL in question and STOP in question
    assert "You are the fork" in question
    assert all(verdict in question for verdict in VERDICTS)


def test_continue_to_work_prompts_the_session_to_go_on(monitored):
    monitored.answers = [_reply("continue_to_work")]
    result = nudge()
    assert result.exit_code == 0, result.output
    prompts = monitored.prompted()
    assert len(prompts) == 1
    assert GOAL in prompts[0] and STOP in prompts[0]
    # Nothing in it is read, but a terminal session's turn is cancelled when its listener hangs up.
    assert monitored.prompt_responses[0].drained
    assert monitored.folder.exists()  # still monitoring


def test_a_prompt_the_session_does_not_take_fails_the_nudge(monitored):
    monitored.answers = [_reply("continue_to_work")]
    monitored.prompt_refused = True
    refused(nudge(), "PROMPT_REFUSED")


@pytest.mark.parametrize("verdict", ["goal_met", "stop_condition_reached"])
def test_a_met_goal_or_a_reached_stop_ends_the_monitor_and_tells_no_one(monitored, verdict):
    monitored.answers = [_reply(verdict)]
    result = nudge()
    assert result.exit_code == 0, result.output
    assert not monitored.folder.exists()
    assert ("DELETE", f"trigger/{TRIGGER_ID}", {}) in monitored.calls
    assert monitored.prompted() == []


def test_an_invalid_answer_is_asked_again_on_the_same_fork(monitored):
    monitored.answers = ["sure, looks good", _reply("continue_to_work")]
    assert nudge().exit_code == 0
    assert [pid for pid, _ in monitored.asked] == [FORK_ID, FORK_ID]
    retry = monitored.asked[1][1]
    assert "invalid" in retry.lower()
    assert "Invalid JSON" in retry  # pydantic's own error, handed back
    assert len(monitored.prompted()) == 1


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
    assert monitored.prompted() == []
    assert monitored.folder.exists()


def test_a_session_that_cannot_fork_checks_itself(monitored):
    """No fork to ask: the session is prompted to judge for itself and end the monitor when done."""
    monitored.fork_refused = True
    result = nudge()
    assert result.exit_code == 0, result.output
    assert monitored.asked == []
    (prompt,) = monitored.prompted()
    assert GOAL in prompt and STOP in prompt
    assert f"flow process unmonitor {KEY}" in prompt
    assert monitored.folder.exists()


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
