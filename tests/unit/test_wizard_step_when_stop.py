"""A step's ``when`` (an equality on scope values) and ``on_fail: stop`` (a quiet end).

Real runner, real shell, cli ops only — the two step-level additions on their own, with no
decision in sight.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.core.wizard.runner import Resolved, run_wizard
from flow_sdk.schema.data_spec.compute_op_spec import CliOp, ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec, WizardStepSpec

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

def _op(name: str, command: str, output: str | None = None) -> ComputeOpSpec:
    return ComputeOpSpec(name=name, subkind="cli", output_spec_kind=output,
                         exe_data=CliOp(commands={"darwin": command, "linux": command}))


async def _run(tmp: Path, *steps: WizardStepSpec, **inputs):
    ops = {
        "say-a": _op("say-a", "echo a", "string"),
        "fail": _op("fail", "false"),
        "touch": _op("touch", "touch ran.txt"),
    }

    async def resolve(name):
        return Resolved(ops[name], trusted=True)

    return await run_wizard(WizardSpec(name="w", steps=list(steps)), trusted=True, workdir=tmp,
                            resolve_op=resolve, platform="darwin", inputs=inputs)


async def test_when_matches_a_bound_value_and_skips_otherwise(tmp_path: Path):
    result = await _run(
        tmp_path,
        WizardStepSpec(id="read", ref="say-a", bind="LETTER"),
        WizardStepSpec(id="if-a", ref="touch", when={"LETTER": "a"}),
        WizardStepSpec(id="if-b", ref="touch", when={"LETTER": "b"}),
    )
    assert result.ok
    assert result.steps["if-a"].ran and (tmp_path / "ran.txt").exists()
    skipped = result.steps["if-b"]
    assert skipped.exit_code is ExitCode.NOT_APPLICABLE and not skipped.ran
    assert skipped.detail == "step 'if-b': LETTER is 'a', not 'b'"


async def test_when_on_a_name_not_in_scope_skips_and_says_so(tmp_path: Path):
    result = await _run(tmp_path, WizardStepSpec(id="only", ref="touch", when={"NOPE": "x"}))
    assert result.ok and not result.ran
    assert result.steps["only"].detail == "step 'only': nothing named 'NOPE' is in scope"


async def test_stop_ends_the_run_quietly(tmp_path: Path):
    result = await _run(
        tmp_path,
        WizardStepSpec(id="gate", ref="fail", on_fail="stop"),
        WizardStepSpec(id="never", ref="touch"),
    )
    assert result.ok and result.stopped_at == "gate"
    assert "never" not in result.steps and not (tmp_path / "ran.txt").exists()
    assert not result.steps["gate"].ok, "the stopping step keeps its own answer"


async def test_stop_is_not_taken_when_the_step_succeeds(tmp_path: Path):
    result = await _run(
        tmp_path,
        WizardStepSpec(id="gate", ref="say-a", on_fail="stop"),
        WizardStepSpec(id="after", ref="touch"),
    )
    assert result.ok and result.stopped_at == "" and result.steps["after"].ran


def test_on_fail_accepts_stop_and_nothing_else_new():
    assert WizardStepSpec(id="s", ref="x", on_fail="stop").on_fail == "stop"
    with pytest.raises(ValueError, match="on_fail must be one of"):
        WizardStepSpec(id="s", ref="x", on_fail="halt")
