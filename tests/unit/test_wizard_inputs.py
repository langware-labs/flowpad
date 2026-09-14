"""Wizard inputs: park on a missing value, resume by re-running.

The whole mechanism rests on a property built for a different reason — verify is
the precondition re-asked, so a re-run skips what is already done. That is why
resume needs no cursor, no continuation, and no persisted step index: `set_input`
just runs the wizard again.

Parking is NOT awaiting. The run RETURNS `pending` and the caller is released.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.core.wizard import run_wizard
from flow_sdk.core.wizard.exec import ShellResult
from flow_sdk.core.wizard.process_step import ProcessResult
from flow_sdk.core.wizard.runner import AWAITING_INPUT, COMPLETED, PENDING, SATISFIED
from flow_sdk.core.wizard.state import input_env
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

SPEC = WizardSpec.model_validate({
    "name": "clone",
    "steps": [
        {"id": "ask-url", "label": "Repository URL",
         "input": {"name": "repo_url", "shape": "string", "label": "Repository URL"}},
        {"id": "clone", "label": "Clone", "on_fail": "abort",
         "command": {"commands": {"linux": "git clone \"$FLOWPAD_WIZARD_INPUT_REPO_URL\""}},
         "verify": {"commands": {"linux": "test -d repo"}}},
    ],
})


async def _run(tmp_path, inputs=None, shell=None, launch=None, path="wizard-inp", resume=True):
    async def _ok(_c, **_kw):
        return ShellResult(returncode=0)

    async def _launch(**_kw):
        return ProcessResult("p", True)

    return await run_wizard(
        SPEC, subject_entity=None, activity_path=path, trusted=True, workdir=Path(tmp_path),
        # `resume` is `execute_wizard`'s decision, expressed here as what it
        # passes down: the stored answers on a resume, nothing on a fresh run.
        inputs=(inputs if resume else None),
        shell=shell or _ok, launch=launch or _launch, platform="linux",
    )


@pytest.mark.asyncio
async def test_a_missing_input_parks_and_says_what_it_needs(tmp_path):
    result = await _run(tmp_path, path="wizard-inp-a")
    assert result.status == PENDING
    assert result.pending and not result.ok
    assert [item.name for item in result.awaiting] == ["repo_url"]
    assert result.awaiting[0].to_payload()["shape"] == "string"
    assert result.awaiting[0].label == "Repository URL"


@pytest.mark.asyncio
async def test_parking_does_not_run_the_steps_after_it(tmp_path):
    ran: list[str] = []

    async def shell(command, **_kw):
        ran.append(command)
        return ShellResult(returncode=0)

    result = await _run(tmp_path, shell=shell, path="wizard-inp-b")
    assert result.status == PENDING
    assert ran == [], "a parked run must not go on to the steps that need the value"
    assert [o.status for o in result.outcomes] == [AWAITING_INPUT, "not_reached"]
    # A parked step did NOT fail, and the later step's message must not say it
    # did — that wording sends a person debugging a step that is perfectly fine.
    assert "failed" not in (result.outcomes[1].message or "")
    assert "asked for input" in (result.outcomes[1].message or "")


@pytest.mark.asyncio
async def test_given_the_value_the_run_completes(tmp_path):
    result = await _run(tmp_path, inputs={"repo_url": "https://x/y"}, path="wizard-inp-c")
    assert result.status == COMPLETED
    assert [o.status for o in result.outcomes] == [SATISFIED, COMPLETED]


@pytest.mark.asyncio
async def test_an_optional_input_skips_instead_of_parking(tmp_path):
    body = SPEC.model_dump()
    body["steps"][0]["input"]["optional"] = True
    spec = WizardSpec.model_validate(body)

    async def _ok(_c, **_kw):
        return ShellResult(returncode=0)

    async def _launch(**_kw):
        return ProcessResult("p", True)

    result = await run_wizard(spec, subject_entity=None, activity_path="wizard-inp-d", trusted=True,
                              workdir=Path(tmp_path), shell=_ok, launch=_launch, platform="linux")
    assert result.status == COMPLETED
    assert result.outcomes[0].status == "not_applicable"


@pytest.mark.asyncio
async def test_the_value_reaches_a_command_as_env_never_as_the_command(tmp_path):
    """Substituting into a shell string would make `; rm -rf /` executable —
    straight through the trust gate that decides whether this wizard may run
    shell at all. As env it can change a command's environment, never which
    command runs."""
    seen: dict = {}

    async def shell(command, **kw):
        seen["command"] = command
        seen["env"] = kw.get("extra_env") or {}
        return ShellResult(returncode=0)

    hostile = "; rm -rf / #"
    await _run(tmp_path, inputs={"repo_url": hostile}, shell=shell, path="wizard-inp-e")
    assert hostile not in seen["command"], "the value must never be inlined into the command"
    assert seen["env"]["FLOWPAD_WIZARD_INPUT_REPO_URL"] == hostile


def test_env_names_are_derived_not_guessed():
    assert input_env({"repo url": "x", "a-b": 1})["FLOWPAD_WIZARD_INPUT_REPO_URL"] == "x"
    assert input_env({"a-b": 1})["FLOWPAD_WIZARD_INPUT_A_B"] == "1"


@pytest.mark.asyncio
async def test_resume_is_just_a_re_run_and_redoes_nothing(tmp_path):
    """The idempotency property doing the work: on the second pass the clone
    step's precondition/verify say it is already done, so it skips."""
    done = {"cloned": False}

    async def shell(command, **_kw):
        if "clone" in command:
            done["cloned"] = True
            return ShellResult(returncode=0)
        return ShellResult(returncode=0 if done["cloned"] else 1)

    body = SPEC.model_dump()
    body["steps"][1]["precondition"] = {"commands": {"linux": "test -d repo"}}
    spec = WizardSpec.model_validate(body)

    async def _launch(**_kw):
        return ProcessResult("p", True)

    first = await run_wizard(spec, subject_entity=None, activity_path="wizard-inp-f", trusted=True,
                             workdir=Path(tmp_path), shell=shell, launch=_launch, platform="linux")
    assert first.status == PENDING

    second = await run_wizard(spec, subject_entity=None, activity_path="wizard-inp-f", trusted=True,
                              workdir=Path(tmp_path), inputs={"repo_url": "u"},
                              shell=shell, launch=_launch, platform="linux")
    assert second.status == COMPLETED

    third = await run_wizard(spec, subject_entity=None, activity_path="wizard-inp-f", trusted=True,
                             workdir=Path(tmp_path), inputs={"repo_url": "u"},
                             shell=shell, launch=_launch, platform="linux")
    assert [o.status for o in third.outcomes] == [SATISFIED, SATISFIED], (
        "a third run must do nothing — verify re-asks and everything is already true"
    )


def test_reading_the_run_state_twice_reads_the_file_once(tmp_path, monkeypatch):
    """`Wizard.run_state` is a computed field, so this is a SERIALIZATION path.

    An uncached read is one open+parse per row of `GET /graph/wizard` and again
    on every WS entity push — synchronous file I/O on the event loop for a value
    that changes only when a run does.
    """
    from flow_sdk.core.wizard import state as wizard_state

    monkeypatch.setattr(wizard_state, "run_dir", lambda wid: tmp_path / wid)
    wizard_state._CACHE.clear()

    reads = {"n": 0}
    real = wizard_state.read_json

    def counting(path):
        reads["n"] += 1
        return real(path)

    monkeypatch.setattr(wizard_state, "read_json", counting)

    wizard_state.record_result("wz", status="completed", awaiting=[], outcomes=[])
    reads["n"] = 0

    assert wizard_state.read_state("wz")["status"] == "completed"
    assert wizard_state.read_state("wz")["status"] == "completed"
    assert reads["n"] == 1, "the second read should be a stat, not a re-parse"

    # ...and a write is seen immediately, not after a stat happens to differ.
    wizard_state.record_result("wz", status="failed", awaiting=[], outcomes=[])
    assert wizard_state.read_state("wz")["status"] == "failed"


def test_a_wizard_that_never_ran_does_not_re_stat_on_every_serialization(tmp_path, monkeypatch):
    """The common case is a MISSING file, so the absence has to be cached too —
    otherwise the fast path is exactly the one that never hits."""
    from flow_sdk.core.wizard import state as wizard_state

    monkeypatch.setattr(wizard_state, "run_dir", lambda wid: tmp_path / wid)
    wizard_state._CACHE.clear()

    reads = {"n": 0}
    real = wizard_state.read_json

    def counting(path):
        reads["n"] += 1
        return real(path)

    monkeypatch.setattr(wizard_state, "read_json", counting)

    assert wizard_state.read_state("never-run") == {}
    assert wizard_state.read_state("never-run") == {}
    assert reads["n"] == 1


@pytest.mark.asyncio
async def test_a_fresh_run_asks_again_instead_of_reusing_the_last_answer(tmp_path):
    """"Run it again" must ASK, not silently reuse.

    Reusing made a re-run re-execute with the answer from last time and produce
    a result identical to the last one, so the button read as dead — and there
    was no way to answer differently at all.
    """
    parked = await _run(tmp_path, inputs={"repo_url": "https://x/one"},
                        path="wizard-fresh-a", resume=False)
    assert parked.status == PENDING
    assert [item.name for item in parked.awaiting] == ["repo_url"]
    assert parked.outcomes[0].status == AWAITING_INPUT


@pytest.mark.asyncio
async def test_resuming_a_parked_run_still_carries_the_answers(tmp_path):
    """The other half, and the reason they are persisted at all. `set-input`
    resumes explicitly; without this, answering a parked wizard would start over
    and re-ask the value just given."""
    resumed = await _run(tmp_path, inputs={"repo_url": "https://x/one"},
                         path="wizard-fresh-b", resume=True)
    assert resumed.status == COMPLETED
    assert resumed.awaiting == []
    assert resumed.outcomes[0].status == SATISFIED


@pytest.mark.asyncio
async def test_an_unattended_run_resumes_by_default(tmp_path):
    """A trigger fire has nobody to ask, so stored answers are the only way it
    can get past an input step. `execute_wizard(resume=...)` defaults ON for
    exactly that caller."""
    import inspect

    from flow_sdk.core.wizard.execute import execute_wizard

    assert inspect.signature(execute_wizard).parameters["resume"].default is True
