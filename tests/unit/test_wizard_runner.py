"""``run_wizard`` — the ask / act / prove state machine.

Every case here drives the real runner with two stub callables in place of the
shell and the agent launcher. That is the point of those seams: the machine has
no I/O of its own, so its whole behaviour is assertable in milliseconds.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.core.wizard import (
    COMPLETED,
    FAILED,
    NOT_APPLICABLE,
    NOT_REACHED,
    SATISFIED,
    WizardNotApproved,
    run_wizard,
)
from flow_sdk.core.wizard.exec import ShellResult
from flow_sdk.core.wizard.process_step import ProcessResult
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

pytestmark = pytest.mark.timeout(5)


def _spec(**over) -> WizardSpec:
    body = {
        "name": "toolchain",
        "steps": [
            {
                "id": "python3", "label": "Python 3", "on_fail": "continue",
                "precondition": {"commands": {"linux": "have python3"}},
                "process": {"prompt": "install python"},
                "verify": {"commands": {"linux": "python3 --version"}},
            },
            {
                "id": "git", "label": "Git", "on_fail": "continue",
                "precondition": {"commands": {"linux": "have git"}},
                "process": {"prompt": "install git"},
                "verify": {"commands": {"linux": "git --version"}},
            },
        ],
    }
    body.update(over)
    return WizardSpec.model_validate(body)


def _shell(code_for):
    async def shell(command, **_kw):
        return ShellResult(returncode=code_for(command))
    return shell


def _launch(record=None, ok=True, message="", process_id="proc-1"):
    async def launch(**kw):
        if record is not None:
            record.append(kw["prompt"])
        return ProcessResult(process_id, ok, message)
    return launch


def _statuses(result):
    return [outcome.status for outcome in result.outcomes]


async def _run(spec, shell, launch, *, path, tmp_path):
    return await run_wizard(
        spec, subject_entity="wizard-test", activity_path=path, trusted=True,
        workdir=Path(tmp_path), shell=shell, launch=launch, platform="linux",
    )


@pytest.mark.asyncio
async def test_already_satisfied_skips_and_never_acts(tmp_path):
    launched: list[str] = []
    result = await _run(_spec(), _shell(lambda _c: 0), _launch(launched),
                        path="wz/satisfied", tmp_path=tmp_path)
    assert result.ok
    assert _statuses(result) == [SATISFIED, SATISFIED]
    assert launched == [], "a satisfied precondition must not run the action"


@pytest.mark.asyncio
async def test_missing_then_installed_then_verified(tmp_path):
    present = {"python3": False, "git": False}

    async def shell(command, **_kw):
        key = "python3" if "python3" in command else "git"
        return ShellResult(returncode=0 if present[key] else 1)

    async def launch(**kw):
        present["python3" if "python" in kw["prompt"] else "git"] = True
        return ProcessResult("proc-x", True)

    result = await _run(_spec(), shell, launch, path="wz/installed", tmp_path=tmp_path)
    assert result.ok
    assert _statuses(result) == [COMPLETED, COMPLETED]


@pytest.mark.asyncio
async def test_an_agent_that_claims_success_still_fails_its_verify(tmp_path):
    """THE honesty property. A worker can finish cleanly and report a tidy
    summary having installed nothing; only the verify command is evidence."""
    result = await _run(_spec(), _shell(lambda _c: 1), _launch(ok=True, message="all done!"),
                        path="wz/liar", tmp_path=tmp_path)
    assert not result.ok
    assert _statuses(result) == [FAILED, FAILED]
    assert "did not take effect" in result.outcomes[0].message


@pytest.mark.asyncio
async def test_abort_leaves_later_steps_not_reached_and_never_invokes_them(tmp_path):
    launched: list[str] = []
    spec = _spec()
    body = spec.model_dump()
    body["steps"][0]["on_fail"] = "abort"
    result = await _run(WizardSpec.model_validate(body), _shell(lambda _c: 1),
                        _launch(launched, ok=False, message="boom", process_id=None),
                        path="wz/abort", tmp_path=tmp_path)
    assert not result.ok
    assert _statuses(result) == [FAILED, NOT_REACHED]
    assert len(launched) == 1, "an aborted run must not touch the remaining steps"


@pytest.mark.asyncio
async def test_continue_runs_the_rest(tmp_path):
    launched: list[str] = []
    result = await _run(_spec(), _shell(lambda _c: 1),
                        _launch(launched, ok=False, message="boom", process_id=None),
                        path="wz/continue", tmp_path=tmp_path)
    assert not result.ok
    assert _statuses(result) == [FAILED, FAILED]
    assert len(launched) == 2


@pytest.mark.asyncio
async def test_a_step_with_no_command_for_this_platform_is_not_applicable(tmp_path):
    body = _spec().model_dump()
    for step in body["steps"]:
        step["precondition"]["commands"] = {"win32": "whatever"}
    launched: list[str] = []
    result = await _run(WizardSpec.model_validate(body), _shell(lambda _c: 0), _launch(launched),
                        path="wz/wrong-os", tmp_path=tmp_path)
    assert result.ok, "a step that does not apply here is not a failure"
    assert _statuses(result) == [NOT_APPLICABLE, NOT_APPLICABLE]
    assert launched == []


@pytest.mark.asyncio
async def test_a_step_records_its_process_id_even_when_it_fails(tmp_path):
    result = await _run(_spec(), _shell(lambda _c: 1),
                        _launch(ok=False, message="nope", process_id="proc-7"),
                        path="wz/pid", tmp_path=tmp_path)
    assert result.outcomes[0].process_id == "proc-7", "a failed run must stay linkable"


@pytest.mark.asyncio
async def test_untrusted_refuses_before_running_anything(tmp_path):
    touched: list[str] = []

    async def shell(command, **_kw):
        touched.append(command)
        return ShellResult(returncode=0)

    with pytest.raises(WizardNotApproved):
        await run_wizard(_spec(), trusted=False, workdir=Path(tmp_path), shell=shell)
    assert touched == [], "refusal must happen before any command runs"


@pytest.mark.asyncio
async def test_a_command_step_that_exits_nonzero_fails_with_its_output(tmp_path):
    spec = WizardSpec.model_validate({"name": "c", "steps": [{
        "id": "only", "on_fail": "abort",
        "command": {"commands": {"linux": "false"}},
    }]})

    async def shell(_command, **_kw):
        return ShellResult(returncode=2, stderr="permission denied")

    result = await _run(spec, shell, _launch(), path="wz/cmdfail", tmp_path=tmp_path)
    assert not result.ok
    assert result.outcomes[0].returncode == 2
    assert "permission denied" in result.outcomes[0].message
