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
from flow_sdk.core.wizard.exec import PROBE_OUTPUT_CAP, ShellResult
from flow_sdk.core.wizard.runner import COMPLETED, FAILED
from flow_sdk.core.wizard.state import reset_run
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

SPEC = WizardSpec.model_validate({
    "name": "probed",
    "steps": [{
        "id": "one", "label": "One",
        "precondition": {"commands": {"darwin": "test -f marker", "linux": "test -f marker"}},
        "command": {"commands": {"darwin": "make-it", "linux": "make-it"}},
        "verify": {"commands": {"darwin": "test -f made", "linux": "test -f made"}},
    }],
})


def _shell(*, fail: str = "", stdout: str = "", record: "list | None" = None):
    """A shell double: every command succeeds unless it starts with `fail`.

    The four probe tests differ only in which command fails and what it prints,
    so that is what this takes — leaving each test body to be its assertion.
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
        workdir=Path(tmp_path), shell=shell,
    )


def test_probes_record_all_three_phases_with_resolved_commands(tmp_path):
    """Precondition, action and verify each leave a probe, in order."""
    seen: list[str] = []
    # The precondition fails, so the step acts; action and verify succeed.
    result = asyncio.run(_run(tmp_path, _shell(fail="test -f marker", record=seen)))
    outcome = result.outcomes[0]
    assert outcome.status == COMPLETED
    phases = [probe.phase for probe in outcome.probes]
    assert phases == ["precondition", "action", "verify"]
    # The RESOLVED command, not the per-OS map: what actually ran on this box.
    assert outcome.probes[1].command == "make-it"
    assert outcome.probes[1].stdout == "out:make-it"
    assert outcome.probes[0].returncode == 1


def test_every_terminal_outcome_carries_a_real_duration(tmp_path):
    """`completed` and `failed` both reported 0.0 — the fields were positional."""
    completed = asyncio.run(_run(tmp_path, _shell()))
    assert completed.outcomes[0].duration_s > 0

    # Everything but the action succeeds, so the step reaches a FAILED verify.
    failed = asyncio.run(_run(tmp_path, _shell(fail="test -f")))
    assert failed.outcomes[0].status == FAILED
    assert failed.outcomes[0].duration_s > 0


def test_a_verify_failure_keeps_the_actions_output(tmp_path):
    """The sentence says verify failed; the action's probe still has the why."""
    async def shell(command, **_kw):
        if command.startswith("make-it"):
            return ShellResult(returncode=0, stdout="wrote nothing, actually")
        return ShellResult(returncode=1)

    outcome = asyncio.run(_run(tmp_path, shell)).outcomes[0]
    assert outcome.status == FAILED
    action = next(p for p in outcome.probes if p.phase == "action")
    assert action.stdout == "wrote nothing, actually"


def test_streams_are_tail_capped_and_say_so(tmp_path):
    """The END is where the error is, so the tail is what survives."""
    long_output = "x" * (PROBE_OUTPUT_CAP + 500) + "TAIL"
    outcome = asyncio.run(
        _run(tmp_path, _shell(fail="test -f marker", stdout=long_output))
    ).outcomes[0]
    action = next(p for p in outcome.probes if p.phase == "action")
    assert action.truncated is True
    assert len(action.stdout) == PROBE_OUTPUT_CAP
    assert action.stdout.endswith("TAIL")


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
        {"id": "a", "command": {"commands": {"linux": "true"}}},
        {"id": "a", "command": {"commands": {"linux": "true"}}},
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
