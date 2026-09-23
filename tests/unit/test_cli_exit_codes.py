"""Every `flow` command that runs something exits its ANSWER's exit code.

The contract (docs/snippets/call-returns.md): 0 done, 1 not yet, 3 not applicable,
4 no such thing, 7 refused — the same `ExitCode` an in-process call returns — and
2 when the request itself failed, 5 when the server could not be reached. These
pin the commands that drifted from it:

* `flow wizard` spent 7 on a failed HTTP request — and 7 IS ExitCode.REFUSED.
* `flow terminal run` always exited 0, and gave up on HTTP after 10 s while the
  command it carried was allowed 120.
* `flow op` turned a 200 with no answer into NOT_YET (1) instead of a failed
  request (2), and waited the default budget even for an op that declares more.

The HTTP layer is stubbed; what is under test is the mapping from answer to exit.
"""
from __future__ import annotations

import pytest
import typer

from flow_sdk.cli.commands import op_cmd, terminal_cmd, wizard_cmd

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


def _exit_code(call) -> int:
    with pytest.raises((typer.Exit, SystemExit)) as ended:
        call()
    exc = ended.value
    return exc.exit_code if isinstance(exc, typer.Exit) else exc.code


# ── flow wizard run ──────────────────────────────────────────────────────────

def _wizard_server(monkeypatch, *, post):
    monkeypatch.setattr(wizard_cmd, "_discover_port", lambda: 1)
    monkeypatch.setattr(
        wizard_cmd, "_get_graph_json",
        lambda url, on_error=None: {"entities": [{"id": "w1", "name": "setup"}]},
    )
    monkeypatch.setattr(wizard_cmd, "_post_graph_json", post)


def test_wizard_run_exits_a_refusal_as_7(monkeypatch):
    _wizard_server(monkeypatch, post=lambda url, body, timeout, on_error: {"exit_code": 7, "ran": False})
    assert _exit_code(lambda: wizard_cmd._run_from_args(["setup"])) == 7


def test_wizard_run_exits_busy_as_not_yet_not_as_a_failed_request(monkeypatch):
    """409 is the one status the edge spends, and it still carries the answer."""
    def post(url, body, timeout, on_error):
        on_error(409, {"message": "already running", "data": {"exit_code": 1, "busy": True, "ran": False}})

    _wizard_server(monkeypatch, post=post)
    assert _exit_code(lambda: wizard_cmd._run_from_args(["setup"])) == 1


def test_wizard_run_exits_2_when_the_request_itself_failed(monkeypatch):
    def post(url, body, timeout, on_error):
        on_error(500, {"message": "boom"})

    _wizard_server(monkeypatch, post=post)
    assert _exit_code(lambda: wizard_cmd._run_from_args(["setup"])) == 2


def test_wizard_run_exits_2_for_a_200_with_no_answer(monkeypatch):
    _wizard_server(monkeypatch, post=lambda url, body, timeout, on_error: {"status": "ok"})
    assert _exit_code(lambda: wizard_cmd._run_from_args(["setup"])) == 2


def test_wizard_run_of_an_unknown_wizard_exits_not_found(monkeypatch):
    _wizard_server(monkeypatch, post=lambda *a, **k: pytest.fail("nothing to run"))
    assert _exit_code(lambda: wizard_cmd._run_from_args(["nope"])) == 4


def test_wizard_close_exits_2_not_7_when_the_request_fails(monkeypatch):
    """7 is REFUSED; a failed request is 2."""
    def post(url, body, timeout, on_error):
        on_error(500, {"message": "boom"})

    monkeypatch.setattr(wizard_cmd, "_discover_port", lambda: 1)
    monkeypatch.setattr(wizard_cmd, "_post_graph_json", post)
    code = _exit_code(lambda: wizard_cmd._close_from_args("proc-1", ["close", '{"status": "done"}']))
    assert code == 2


# ── flow terminal run ────────────────────────────────────────────────────────

def _terminal(monkeypatch, answer: dict) -> dict:
    seen: dict = {}

    def post(url, body, timeout, on_error):
        seen["timeout"] = timeout
        return answer

    monkeypatch.setattr(terminal_cmd, "_resolve_process_id", lambda _opt: "proc-1")
    monkeypatch.setattr(terminal_cmd, "_discover_port", lambda: 1)
    monkeypatch.setattr(terminal_cmd, "_post_graph_json", post)
    return seen


def test_terminal_run_exits_the_commands_answer(monkeypatch):
    _terminal(monkeypatch, {"exit_code": 1, "returncode": 3})
    assert _exit_code(lambda: terminal_cmd.terminal_run("false", None, 120.0, None)) == 1


def test_terminal_run_outwaits_the_command_it_carries(monkeypatch):
    """The server returns when the command ends or ITS timeout does; a client that
    gave up at 10 s reported a 60 s build as a connection error."""
    seen = _terminal(monkeypatch, {"exit_code": 0})
    assert _exit_code(lambda: terminal_cmd.terminal_run("make", None, 300.0, None)) == 0
    assert seen["timeout"] > 300.0


# ── flow op ──────────────────────────────────────────────────────────────────

def test_op_exits_2_for_a_200_with_no_answer():
    assert _exit_code(lambda: op_cmd._exit_with(None)) == 2
    assert _exit_code(lambda: op_cmd._exit_with({"status": "ok"})) == 2


def test_op_waits_as_long_as_the_op_may_take():
    """check + call + re-check, and never less than the default budget."""
    plain = op_cmd._wait_for({})
    long_op = op_cmd._wait_for({"exe_data": {"timeout_seconds": 7200}})
    assert plain > op_cmd.RUN_TIMEOUT_SECONDS
    assert long_op > 7200 + 2 * op_cmd.CHECK_TIMEOUT
