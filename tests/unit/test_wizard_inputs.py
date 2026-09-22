"""Wizard values and the run record.

A wizard no longer parks on a person: a person is asked by an `ask` ComputeOp,
like any other step. What is left here is what a sequence still owns about
VALUES — they reach a command as environment, never as text — and the run
record on disk, `run.json`: `approved` plus the last `WizardResult`.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.core.wizard import run_wizard
from flow_sdk.core.wizard.runner import Resolved
from flow_sdk.core.wizard.state import input_env
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import CliResult, PromptResult, WizardResult
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

SPEC = WizardSpec.model_validate({
    "name": "clone",
    "steps": [
        {"id": "clone", "label": "Clone", "kind": "compute", "ref": "clone-repo", "on_fail": "abort"},
    ],
})

#: The work the step calls. The value reaches its command as ENVIRONMENT — the
#: quoting here is the injection guard's subject, not decoration.
CLONE_OP = ComputeOpSpec.model_validate({
    "name": "clone-repo",
    "subkind": "cli",
    "exe_data": {"commands": {"linux": 'git clone "$FLOWPAD_WIZARD_INPUT_REPO_URL"'}},
    "completion_check": {"commands": {"linux": "test -d repo"}},
})


async def _resolve_op(name):
    return Resolved(CLONE_OP, True) if name == "clone-repo" else None


async def _launch(**_kw):
    return PromptResult.satisfied("The agent finished.")


async def _run(tmp_path, shell, *, inputs=None, path="wizard-inp"):
    return await run_wizard(
        SPEC, subject_entity=None, activity_path=path, trusted=True, workdir=Path(tmp_path),
        inputs=inputs or {}, shell=shell, launch=_launch, platform="linux", resolve_op=_resolve_op,
    )


@pytest.mark.asyncio
async def test_the_value_reaches_a_command_as_env_never_as_the_command(tmp_path):
    """Substituting into a shell string would make `; rm -rf /` executable —
    straight through the trust gate that decides whether this wizard may run
    shell at all. As env it can change a command's environment, never which
    command runs."""
    seen: list[tuple[str, dict]] = []

    async def shell(command, **kw):
        seen.append((command, dict(kw.get("extra_env") or {})))
        return CliResult.of_process(command, 0)

    hostile = "; rm -rf / #"
    await _run(tmp_path, shell, inputs={"repo_url": hostile}, path="wizard-inp-e")
    assert not any(hostile in command for command, _env in seen), "the value must never be inlined"
    assert all(env["FLOWPAD_WIZARD_INPUT_REPO_URL"] == hostile for _c, env in seen)


def test_env_names_are_derived_not_guessed():
    assert input_env({"repo url": "x", "a-b": 1})["FLOWPAD_WIZARD_INPUT_REPO_URL"] == "x"
    assert input_env({"a-b": 1})["FLOWPAD_WIZARD_INPUT_A_B"] == "1"


@pytest.mark.asyncio
async def test_running_again_redoes_nothing(tmp_path):
    """The idempotency property doing the work: on the second run the clone
    op's check says it is already done, so the step does nothing."""
    done = {"cloned": False}

    async def shell(command, **_kw):
        if "clone" in command:
            done["cloned"] = True
            return CliResult.of_process(command, 0)
        return CliResult.of_process(command, 0 if done["cloned"] else 1)

    first = await _run(tmp_path, shell, inputs={"repo_url": "u"}, path="wizard-inp-f")
    assert first.ok and first.steps["clone"].ran is True

    second = await _run(tmp_path, shell, inputs={"repo_url": "u"}, path="wizard-inp-f")
    assert second.ok and second.ran is False, "a second run must do nothing — the check re-asks and holds"


def _wizard_state(tmp_path, monkeypatch):
    from flow_sdk.core.wizard import state as wizard_state

    monkeypatch.setattr(wizard_state, "run_dir", lambda wid: tmp_path / wid)
    wizard_state._CACHE.clear()
    return wizard_state


def test_the_run_record_is_the_results_dump(tmp_path, monkeypatch):
    """`run.json` holds the `WizardResult` whole, so reading it back gives the
    same answers — each step as its own subclass."""
    wizard_state = _wizard_state(tmp_path, monkeypatch)
    result = WizardResult.not_yet("clone: it failed.", steps={"clone": CliResult.of_process("git clone u", 128, stderr="no")})

    wizard_state.record_result("wz", result)

    again = wizard_state.read_result("wz")
    assert again == result
    assert type(again.steps["clone"]) is CliResult


def test_an_old_shape_record_reads_as_never_run(tmp_path, monkeypatch):
    """No compatibility path: a `run.json` in the shape this version does not
    write (status / outcomes / awaiting) is "no run yet", not a crash."""
    wizard_state = _wizard_state(tmp_path, monkeypatch)
    (tmp_path / "old").mkdir()
    (tmp_path / "old" / "run.json").write_text(json.dumps({
        "status": "pending", "awaiting": [{"name": "TOKEN"}], "outcomes": [], "approved": True,
    }))

    assert wizard_state.read_result("old") is None
    assert wizard_state.is_approved("old"), "approval is a fact about the wizard and survives"


def test_reading_the_run_state_twice_reads_the_file_once(tmp_path, monkeypatch):
    """`Wizard.run_state` is a computed field, so this is a SERIALIZATION path.

    An uncached read is one open+parse per row of `GET /graph/wizard` and again
    on every WS entity push — synchronous file I/O on the event loop for a value
    that changes only when a run does.
    """
    wizard_state = _wizard_state(tmp_path, monkeypatch)
    reads = {"n": 0}
    real = wizard_state.read_json

    def counting(path):
        reads["n"] += 1
        return real(path)

    monkeypatch.setattr(wizard_state, "read_json", counting)

    wizard_state.record_result("wz", WizardResult.satisfied("done"))
    reads["n"] = 0

    assert wizard_state.read_result("wz").detail == "done"
    assert wizard_state.read_result("wz").detail == "done"
    assert reads["n"] == 1, "the second read should be a stat, not a re-parse"

    # ...and a write is seen immediately, not after a stat happens to differ.
    wizard_state.record_result("wz", WizardResult.not_yet("failed"))
    assert wizard_state.read_result("wz").detail == "failed"


def test_a_wizard_that_never_ran_does_not_re_stat_on_every_serialization(tmp_path, monkeypatch):
    """The common case is a MISSING file, so the absence has to be cached too —
    otherwise the fast path is exactly the one that never hits."""
    wizard_state = _wizard_state(tmp_path, monkeypatch)
    reads = {"n": 0}
    real = wizard_state.read_json

    def counting(path):
        reads["n"] += 1
        return real(path)

    monkeypatch.setattr(wizard_state, "read_json", counting)

    assert wizard_state.read_state("never-run") == {}
    assert wizard_state.read_result("never-run") is None
    assert reads["n"] == 1
