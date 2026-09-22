"""What a run RECORDED, and how a person throws it away.

Two surfaces the viewer's debugger rests on:

* **a step's answer** — the op's own result: the command its call ran, as
  resolved for this platform, with both streams, and the completion check that
  decided its verdict (`check`). There is no separate probe record any more:
  the answer IS the record.
* **reset** — archive-then-fresh, refusing while a run holds the wizard's lock.

The payload guard at the bottom is the load-bearing one: a step's output rides
`run-detail` only, because `run_state` is a computed field that rides every row
of ``GET /graph/wizard`` and every WS entity push.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from flow_sdk.builtin.wizard import Wizard
from flow_sdk.core.wizard import run_wizard
from flow_sdk.core.wizard.runner import Resolved
from flow_sdk.core.wizard.state import reset_run
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import CliResult, ExitCode, WizardResult
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

SPEC = WizardSpec.model_validate({
    "name": "probed",
    "steps": [{"id": "one", "label": "One", "kind": "compute", "ref": "make-it"}],
})

#: The work the step calls: one question, one call.
OP = ComputeOpSpec.model_validate({
    "name": "make-it",
    "subkind": "cli",
    "exe_data": {"commands": {"darwin": "make-it", "linux": "make-it"}},
    "completion_check": {"commands": {"darwin": "test -f made", "linux": "test -f made"}},
})


async def _resolve_op(name):
    return Resolved(OP, True) if name == "make-it" else None


def _shell(*, fail: str = "", stdout: str = "", record: "list | None" = None):
    """A shell double: every command succeeds unless it starts with `fail`."""
    async def run(command, **_kw):
        if record is not None:
            record.append(command)
        code = 1 if fail and command.startswith(fail) else 0
        return CliResult.of_process(command, code, stdout or f"out:{command}", "err")

    return run


async def _run(tmp_path, shell):
    return await run_wizard(
        SPEC, subject_entity=None, activity_path="wizard-probe", trusted=True,
        workdir=Path(tmp_path), shell=shell, platform="linux", resolve_op=_resolve_op,
    )


def test_a_step_records_its_call_and_the_check_that_judged_it(tmp_path):
    """The step's answer carries the RESOLVED command its call ran and, in
    `check`, the completion check whose verdict it reports — so a failed step
    shows both what ran and why it did not count."""
    seen: list[str] = []
    # The check fails, so the op calls; the call succeeds, the re-check still fails.
    step = asyncio.run(_run(tmp_path, _shell(fail="test -f made", record=seen))).steps["one"]

    assert step.exit_code is ExitCode.NOT_YET, "the check never passes, so the goal is not reached"
    # The RESOLVED command, not the per-OS map: what actually ran on this box.
    assert step.command == "make-it" and step.returncode == 0
    assert step.check.command == "test -f made" and step.check.returncode == 1
    assert seen[0] == "test -f made", "the question is asked before anything acts"


def test_a_step_that_ran_carries_a_real_duration(tmp_path):
    step = asyncio.run(_run(tmp_path, _shell(fail="test -f"))).steps["one"]
    assert step.exit_code is ExitCode.NOT_YET
    assert step.ran is True and step.duration_s > 0


def test_a_satisfied_step_carries_the_check_that_proved_it(tmp_path):
    step = asyncio.run(_run(tmp_path, _shell())).steps["one"]
    assert step.ok and step.ran is False
    assert step.check.command == "test -f made" and step.check.returncode == 0


def test_a_failed_goal_keeps_the_calls_output(tmp_path):
    """The sentence says the goal was not reached; the answer still has the why."""
    async def shell(command, **_kw):
        if command.startswith("make-it"):
            return CliResult.of_process(command, 0, "wrote nothing, actually")
        return CliResult.of_process(command, 1)

    step = asyncio.run(_run(tmp_path, shell)).steps["one"]
    assert step.exit_code is ExitCode.NOT_YET
    assert step.stdout == "wrote nothing, actually"
    assert "\n" not in step.detail, "detail is one sentence; the output lives in its own field"


# --- reset -----------------------------------------------------------------

def _wizard(tmp_path, monkeypatch, doc=None):
    from flow_sdk.core.wizard import state as wizard_state

    monkeypatch.setattr(wizard_state, "run_dir", lambda wid: tmp_path / "runs" / wid)
    folder = tmp_path / "agentic-assets" / "wizard" / "demo"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "wizard.json").write_text(json.dumps(doc or {
        "name": "demo", "steps": [{"id": "a", "command": {"commands": {"linux": "true"}}}],
    }))
    return Wizard(name="demo", asset_ref=str(folder))


def test_reset_archives_the_run_and_preserves_approval(tmp_path, monkeypatch):
    """Approval is a fact about trusting THIS WIZARD, not about one run's answers."""
    from flow_sdk.core.wizard.state import archived_runs, read_result, record_approval, record_result

    wizard = _wizard(tmp_path, monkeypatch)
    wid = str(wizard.id)
    record_approval(wid)
    record_result(wid, WizardResult.not_yet("boom", steps={"a": CliResult.of_process("false", 1)}))

    fresh = reset_run(wid)
    assert fresh == {"approved": True}
    assert read_result(wid) is None
    # Archived, never unlinked — a reset button is exactly where someone loses
    # the evidence they were about to read.
    assert len(archived_runs(wid)) == 1
    archived = json.loads(
        (tmp_path / "runs" / wid / "history" / archived_runs(wid)[0]).read_text()
    )
    assert archived["result"]["detail"] == "boom"


def test_reset_refuses_while_a_run_holds_the_lock(tmp_path, monkeypatch):
    """Non-blocking: a caller is told "it is running" now, not parked behind it."""
    from filelock import FileLock

    from flow_sdk.core.wizard import state as wizard_state

    wizard = _wizard(tmp_path, monkeypatch)
    wid = str(wizard.id)
    # Through the module, so the redirect `_wizard` installed applies — binding
    # `run_dir` at import time locks the real flow_home and proves nothing.
    path = wizard_state.run_dir(wid)
    path.mkdir(parents=True, exist_ok=True)
    held = FileLock(str(path / "run.lock"))
    held.acquire(blocking=False)
    try:
        assert reset_run(wid) is None
    finally:
        held.release()


def test_reset_creates_no_activity_node(tmp_path, monkeypatch):
    """`Activity.get` is find-or-CREATE: touching it would fabricate a phantom
    PENDING root in the footer chip for a run that already finished."""
    from flow_sdk.activity import activity as activity_module

    def explode(*_a, **_kw):  # pragma: no cover - the point is that it never runs
        raise AssertionError("reset must not touch the activity tree")

    wizard = _wizard(tmp_path, monkeypatch)
    monkeypatch.setattr(activity_module.Activity, "get", explode, raising=False)
    assert reset_run(str(wizard.id)) is not None


# --- validate ---------------------------------------------------------------

def test_validate_never_raises_and_never_returns_non_2xx(tmp_path, monkeypatch):
    """A driver must not 500 the button — the verdict is the payload."""
    wizard = _wizard(tmp_path, monkeypatch, doc={"name": "x", "steps": [{"id": "a"}]})
    from flow_sdk.responses.response import ApiSuccessResponse

    response = asyncio.run(wizard.validate_action())
    assert isinstance(response, ApiSuccessResponse)
    assert response.data["ok"] is False
    assert response.data["issues"], "a step with no action must be reported"
    assert response.data["issues"][0]["loc"][:2] == ["steps", 0]


def test_validate_reports_a_shipped_wizard_as_read_only(tmp_path, monkeypatch):
    """The frontend's word comes from the backend, not from its own guess."""
    wizard = _wizard(tmp_path, monkeypatch)
    monkeypatch.setattr(Wizard, "is_system", lambda _self: True)
    data = asyncio.run(wizard.validate_action()).data
    assert data["read_only"] is True
    assert data["read_only_reason"]


def test_duplicate_step_ids_warn_rather_than_reject(tmp_path, monkeypatch):
    """An error here would make documents that load today vanish, in repos we
    do not control."""
    wizard = _wizard(tmp_path, monkeypatch, doc={"name": "d", "steps": [
        {"id": "a", "kind": "compute", "ref": "make-it"},
        {"id": "a", "kind": "compute", "ref": "make-it"},
    ]})
    data = asyncio.run(wizard.validate_action()).data
    assert data["ok"] is True
    duplicate = next(i for i in data["issues"] if i["type"] == "duplicate_id")
    assert duplicate["severity"] == "warning"


def test_document_error_names_the_broken_step(tmp_path, monkeypatch):
    """"I saved it and my wizard disappeared" needs a diagnostic somewhere."""
    wizard = _wizard(tmp_path, monkeypatch, doc={"name": "d", "steps": [{"id": "a"}]})
    assert "steps.0" in wizard.document_error


# --- the payload guard ------------------------------------------------------

def test_a_steps_output_rides_run_detail_and_never_run_state(tmp_path, monkeypatch):
    """What a command printed and what a step returned are as heavy as they are
    private: `run_state` is a computed field on every row of `GET /graph/wizard`
    and every WS push; `run-detail` is fetched for the ONE wizard a person opened.
    """
    from flow_sdk.core.wizard.state import record_result

    wizard = _wizard(tmp_path, monkeypatch)
    step = CliResult.of_process(
        "python3 --version", 0, "secret-ish output", "",
        check=CliResult.of_process("test -x python3", 0, "check output"),
    ).model_copy(update={"value": {"version": "3.12.4"}})
    record_result(str(wizard.id), WizardResult.satisfied("", value={"a": {"version": "3.12.4"}}, steps={"a": step}))

    listed = wizard.run_state["result"]
    light = listed["steps"]["a"]
    for heavy in ("stdout", "stderr", "value"):
        assert heavy not in light, heavy
    assert "stdout" not in light["check"]
    assert "value" not in listed
    # The rest of the answer survives, so a list can still say what the step did.
    assert light["exit_code"] == 0 and light["command"] == "python3 --version"

    detail = asyncio.run(wizard.run_detail_action()).data
    assert detail["result"]["steps"]["a"]["stdout"] == "secret-ish output"
    assert detail["result"]["steps"]["a"]["value"] == {"version": "3.12.4"}
    assert detail["result"]["steps"]["a"]["check"]["stdout"] == "check output"
    assert detail["archived"] == []


def test_a_wizard_that_never_ran_has_no_result(tmp_path, monkeypatch):
    wizard = _wizard(tmp_path, monkeypatch)
    assert wizard.run_state == {"result": None, "approved": False}
    assert asyncio.run(wizard.run_detail_action()).data == {"result": None, "archived": []}
