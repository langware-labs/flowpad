"""What a run RECORDED, and how a person throws it away.

Two surfaces the viewer's debugger rests on:

* **probes** — every command a step ran, with the resolved per-OS string and both
  streams. A step runs up to three commands (precondition, action, verify), so a
  flat `command`/`stdout` pair on the outcome has to pick one, and picking one is
  the lie `returncode` already told.
* **reset** — archive-then-fresh, refusing while a run holds the wizard's lock.

The payload guard at the bottom is the load-bearing one: probes carry captured
output, and `run_state` is a computed field that rides every row of
``GET /graph/wizard`` and every WS entity push.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from flow_sdk.builtin.wizard import Wizard
from flow_sdk.core.wizard import run_wizard
from flow_sdk.core.compute.exec import PROBE_OUTPUT_CAP, ShellResult
from flow_sdk.core.wizard.runner import COMPLETED, FAILED
from flow_sdk.core.wizard.state import reset_run
from flow_sdk.core.wizard.runner import Resolved
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

SPEC = WizardSpec.model_validate({
    "name": "probed",
    "steps": [{"id": "one", "label": "One", "kind": "compute", "ref": "make-it"}],
})

#: The work the step calls. One question, one cheap rung — which is the shape a
#: probe describes now: the ATTEMPT that ran, not a phase of a step.
OP = ComputeOpSpec.model_validate({
    "name": "make-it",
    "completion_check": {"commands": {"darwin": "test -f made", "linux": "test -f made"}},
    "attempts": [{"kind": "command", "commands": {"darwin": "make-it", "linux": "make-it"}}],
})


async def _resolve_op(name):
    return Resolved(OP, True) if name == "make-it" else None


def _shell(*, fail: str = "", stdout: str = "", record: "list | None" = None):
    """A shell double: every command succeeds unless it starts with `fail`.

    The probe tests differ only in which command fails and what it prints, so
    that is what this takes — leaving each test body to be its assertion.
    """
    async def run(command, **_kw):
        if record is not None:
            record.append(command)
        code = 1 if fail and command.startswith(fail) else 0
        return ShellResult(returncode=code, stdout=stdout or f"out:{command}", stderr="err")

    return run


async def _run(tmp_path, shell):
    return await run_wizard(
        SPEC, subject_entity=None, activity_path="wizard-probe", trusted=True,
        workdir=Path(tmp_path), shell=shell, platform="linux", resolve_op=_resolve_op,
    )


def test_a_probe_records_the_attempt_that_ran_with_its_resolved_command(tmp_path):
    """One probe per ATTEMPT, named by its rung.

    It used to be three per step — precondition, action, verify — because a step
    ran three commands. A step now makes one CALL, and what varies inside it is
    which rung acted, which is the same question asked of the new shape.
    """
    seen: list[str] = []
    # The check fails, so the op acts; the rung and the re-check then succeed.
    result = asyncio.run(_run(tmp_path, _shell(fail="test -f made", record=seen)))
    outcome = result.outcomes[0]

    assert outcome.status == FAILED, "the check never passes, so the goal is not reached"
    assert [probe.phase for probe in outcome.probes] == ["command"]
    # The RESOLVED command, not the per-OS map: what actually ran on this box.
    assert outcome.probes[0].command == "make-it"
    assert outcome.probes[0].returncode == 0
    assert seen[0] == "test -f made", "the question is asked before anything acts"


def test_every_terminal_outcome_carries_a_real_duration(tmp_path):
    """`completed` and `failed` both reported 0.0 — the fields were positional."""
    satisfied = asyncio.run(_run(tmp_path, _shell()))
    assert satisfied.outcomes[0].duration_s > 0

    failed = asyncio.run(_run(tmp_path, _shell(fail="test -f")))
    assert failed.outcomes[0].status == FAILED
    assert failed.outcomes[0].duration_s > 0


def test_a_failed_goal_keeps_the_rungs_output(tmp_path):
    """The sentence says the goal was not reached; the probe still has the why."""
    async def shell(command, **_kw):
        if command.startswith("make-it"):
            return ShellResult(returncode=0, stdout="wrote nothing, actually")
        return ShellResult(returncode=1)

    outcome = asyncio.run(_run(tmp_path, shell)).outcomes[0]
    assert outcome.status == FAILED
    assert outcome.probes[0].stdout == "wrote nothing, actually"


def test_streams_are_tail_capped_and_say_so(tmp_path):
    """The END is where the error is, so the tail is what survives."""
    long_output = "x" * (PROBE_OUTPUT_CAP + 500) + "TAIL"
    outcome = asyncio.run(
        _run(tmp_path, _shell(fail="test -f made", stdout=long_output))
    ).outcomes[0]
    assert outcome.probes[0].truncated is True
    assert len(outcome.probes[0].stdout) == PROBE_OUTPUT_CAP
    assert outcome.probes[0].stdout.endswith("TAIL")


def test_a_probeless_run_json_still_validates():
    """`extra="forbid"` — a record written before probes existed must still load."""
    from flow_sdk.schema.data_spec.wizard_spec import WizardStepOutcomeSpec

    old = WizardStepOutcomeSpec.model_validate(
        {"step_id": "one", "status": "completed", "message": "", "duration_s": 0.0}
    )
    assert old.probes == []


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
    from flow_sdk.core.wizard.state import archived_runs, read_state, record_approval, record_result

    wizard = _wizard(tmp_path, monkeypatch)
    wid = str(wizard.id)
    record_approval(wid)
    record_result(wid, status="failed", awaiting=[], outcomes=[{"step_id": "a"}], message="boom")

    fresh = reset_run(wid)
    assert fresh == {"approved": True}
    assert read_state(wid).get("status") in (None, "")
    # Archived, never unlinked — a reset button is exactly where someone loses
    # the evidence they were about to read.
    assert len(archived_runs(wid)) == 1
    archived = json.loads(
        (tmp_path / "runs" / wid / "history" / archived_runs(wid)[0]).read_text()
    )
    assert archived["message"] == "boom"


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

def test_an_agents_returned_value_never_rides_run_state(tmp_path, monkeypatch):
    """A returned value is as heavy as a probe and just as private.

    `run_state` is a computed field on every row of `GET /graph/wizard` and
    every WS push; `run-detail` is fetched for the ONE wizard a person opened.
    """
    from flow_sdk.core.wizard.state import record_outputs, record_result

    wizard = _wizard(tmp_path, monkeypatch)
    record_result(str(wizard.id), status="completed", awaiting=[], message="", outcomes=[{
        "step_id": "a", "status": "completed",
        "result": {"version": "3.12.4", "path": "/usr/local/bin/python3"},
    }])
    record_outputs(str(wizard.id), {"release": {"version": "3.12.4"}})

    listed = wizard.run_state
    assert "result" not in listed["outcomes"][0]
    assert "outputs" not in listed
    # The rest of the outcome survives, so a list can still say what the step did.
    assert listed["outcomes"][0]["status"] == "completed"

    detail = asyncio.run(wizard.run_detail_action()).data
    assert detail["outcomes"][0]["result"]["version"] == "3.12.4"
    assert detail["outputs"] == {"release": {"version": "3.12.4"}}


def test_probes_ride_run_detail_and_never_run_state(tmp_path, monkeypatch):
    """`run_state` is a computed field on every row of a list and every WS push."""
    from flow_sdk.core.wizard.state import record_result

    wizard = _wizard(tmp_path, monkeypatch)
    record_result(str(wizard.id), status="completed", awaiting=[], message="", outcomes=[{
        "step_id": "a", "status": "completed", "duration_s": 0.5,
        "probes": [{"phase": "action", "command": "true", "returncode": 0,
                    "stdout": "secret-ish output", "stderr": ""}],
    }])

    listed = wizard.run_state["outcomes"][0]
    assert "probes" not in listed
    assert listed["step_id"] == "a"  # the rest of the outcome survives

    detail = asyncio.run(wizard.run_detail_action()).data
    assert detail["outcomes"][0]["probes"][0]["stdout"] == "secret-ish output"
