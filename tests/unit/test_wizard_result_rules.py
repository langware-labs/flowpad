"""Result-directed early returns belong to every Wizard, independent of its caller."""

from __future__ import annotations

from typing import ClassVar

import pytest

from flow_sdk.core.compute_op.context import CallContext
from flow_sdk.core.wizard import runner
from flow_sdk.core.wizard.plan import plan_wizard
from flow_sdk.core.wizard.runner import Resolved, run_wizard
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, ReturnedValue
from flow_sdk.schema.data_spec.wizard_spec import WizardResultRule, WizardSpec, WizardStepSpec

pytestmark = pytest.mark.timeout(5)


class _Verdict(ReturnedValue):
    spec_kind: ClassVar[str] = ""
    verdict: dict = {}


def _rule(when, returns="result"):
    return {"when": when, "return": returns}


async def _run(tmp_path, monkeypatch, answer, rules, **spec_fields):
    calls = []
    progress = []

    async def call(op, **_kw):
        calls.append(op.name)
        return answer if op.name == "gate" else ReturnedValue.satisfied(value="after")

    async def resolve(name):
        return Resolved(ComputeOpSpec(name=name, subkind="cli", exe_data={"commands": {"linux": "true"}}), True)

    async def on_step(result):
        progress.append(result)

    monkeypatch.setattr(runner, "run_op", call)
    spec = WizardSpec(steps=[WizardStepSpec(id="gate", ref="gate", on_result=rules),
                             WizardStepSpec(id="after", ref="after")], **spec_fields)
    result = await run_wizard(spec, trusted=True, workdir=tmp_path, resolve_op=resolve,
                              context=CallContext(tmp_path, invocation_id="invocation-under-test"),
                              on_step=on_step)
    assert result.invocation_id == "invocation-under-test"
    assert all(p.invocation_id == result.invocation_id for p in progress)
    return result, calls


@pytest.mark.parametrize("when", [{}, {"__class__": "x"}, {"verdict..met": True}, {"value[0]": 1},
                                  {"value": []}, {"value": {"met": True}}])
def test_invalid_rules_are_rejected(when):
    with pytest.raises(ValueError):
        WizardResultRule.model_validate(_rule(when))


def test_rules_round_trip_without_alias_or_scalar_coercion():
    rule = _rule({"verdict.met": False, "exit_code": 1, "value": None})
    parsed = WizardResultRule.model_validate(rule)
    assert type(parsed.when["verdict.met"]) is bool
    assert type(parsed.when["exit_code"]) is int
    assert parsed.model_dump() == rule
    assert WizardResultRule.model_validate_json(parsed.model_dump_json()) == parsed


async def test_first_match_returns_without_leaking_partial_values(tmp_path, monkeypatch):
    answer = _Verdict.not_yet(value={"private": "context"}, verdict={"met": False})
    result, calls = await _run(tmp_path, monkeypatch, answer, [
        _rule({"verdict.met": False}, "not_applicable"), _rule({"exit_code": int(ExitCode.NOT_YET)})])
    assert calls == ["gate"] and result.stopped_at == "gate"
    assert result.exit_code is ExitCode.NOT_APPLICABLE
    assert result.value is None and result.value_present is False
    assert result.steps["gate"].value == {"private": "context"}


@pytest.mark.parametrize("actual,wanted,stops", [(True, 1, False), (1, True, False), (1, 1.0, False),
                                               (False, False, True), (None, None, True), ("1", 1, False)])
async def test_scalar_matching_is_strict(tmp_path, monkeypatch, actual, wanted, stops):
    result, calls = await _run(tmp_path, monkeypatch, _Verdict.satisfied(verdict={"met": actual}),
                              [_rule({"verdict.met": wanted}, "not_applicable")])
    assert (calls == ["gate"]) is stops
    assert (result.exit_code is ExitCode.NOT_APPLICABLE) is stops


@pytest.mark.parametrize("path", ["verdict.absent", "ok", "model_fields"])
async def test_absent_or_undeclared_fields_do_not_match_null(tmp_path, monkeypatch, path):
    _, calls = await _run(tmp_path, monkeypatch, _Verdict.satisfied(), [_rule({path: None})])
    assert calls == ["gate", "after"]


@pytest.mark.parametrize("answer", [ReturnedValue.refused("untrusted"), ReturnedValue.held("busy"),
                                   ReturnedValue.not_yet("timeout", timed_out=True)])
async def test_protected_outcomes_cannot_be_remapped(tmp_path, monkeypatch, answer):
    result, calls = await _run(tmp_path, monkeypatch, answer,
                              [_rule({"exit_code": int(answer.exit_code)}, "not_applicable")])
    assert calls == ["gate"] and result.exit_code is answer.exit_code
    assert result.busy == answer.busy and result.timed_out == answer.timed_out
    assert not result.has_value


async def test_return_result_retains_unavailable_outcome(tmp_path, monkeypatch):
    result, calls = await _run(tmp_path, monkeypatch, ReturnedValue.not_yet("service unavailable", value="partial"),
                              [_rule({"exit_code": int(ExitCode.NOT_YET)})])
    assert calls == ["gate"] and result.exit_code is ExitCode.NOT_YET
    assert result.detail == "service unavailable" and not result.has_value


@pytest.mark.parametrize("value,code", [("accepted", ExitCode.OK), (42, ExitCode.NOT_YET)])
async def test_successful_return_is_held_to_declared_output(tmp_path, monkeypatch, value, code):
    result, calls = await _run(tmp_path, monkeypatch, ReturnedValue.satisfied(value=value),
                              [_rule({"exit_code": 0})], output="string", output_from="gate")
    assert calls == ["gate"] and result.exit_code is code
    assert result.value == (value if code is ExitCode.OK else None)


async def test_preflight_refusal_keeps_invocation_identity(tmp_path):
    spec = WizardSpec(steps=[WizardStepSpec(id="never", ref="never")])
    result = await run_wizard(spec, trusted=False, context=CallContext(tmp_path, invocation_id="refused-call"))
    assert result.exit_code is ExitCode.REFUSED and result.invocation_id == "refused-call"


async def test_a_refusal_after_preparation_never_returns_partial_values(tmp_path, monkeypatch):
    async def call(_run, step, _child):
        return ReturnedValue.satisfied(value="prepared") if step.id == "prepare" else ReturnedValue.refused("no")

    monkeypatch.setattr(runner, "_step", call)
    spec = WizardSpec(steps=[{"id": "prepare", "ref": "prepare"},
                             {"id": "refused", "ref": "refused", "on_result": [_rule({"exit_code": 7}, "not_applicable")]}])
    result = await run_wizard(spec, trusted=True, workdir=tmp_path)
    assert result.exit_code is ExitCode.REFUSED and result.value_present is False and result.value is None
    assert result.steps["prepare"].value == "prepared"


async def test_real_command_return_prevents_a_later_effect(tmp_path):
    async def resolve(name):
        return Resolved(ComputeOpSpec(name=name, subkind="cli", exe_data={"commands": {
            "linux": "false" if name == "gate" else "touch unexpected"
        }}), True)

    spec = WizardSpec(steps=[{"id": "gate", "ref": "gate", "on_result": [
        _rule({"exit_code": int(ExitCode.NOT_YET)}, "not_applicable")]}, {"id": "effect", "ref": "effect"}])
    result = await run_wizard(spec, trusted=True, workdir=tmp_path, platform="linux", resolve_op=resolve)
    assert result.exit_code is ExitCode.NOT_APPLICABLE and not (tmp_path / "unexpected").exists()
    assert list(result.steps) == ["gate"]


@pytest.mark.parametrize("typed,nested", [(False, False), (True, False), (False, True)])
async def test_question_collection_stops_at_return_boundary(tmp_path, typed, nested):
    gate = {"id": "gate", "ref": "gate", "on_result": [_rule({"exit_code": 1})]}
    if typed:
        gate["input_from"] = "$input"
    steps = [gate, {"id": "ask", "ref": "ask", "bind": "answer"}]
    child = WizardSpec(name="child", steps=steps)
    spec = WizardSpec(steps=[{"id": "child", "kind": "wizard", "ref": "child"},
                             {"id": "later", "ref": "ask", "bind": "later"}]) if nested else child
    resolved = []

    async def resolve(name):
        resolved.append(name)
        if name == "child":
            return Resolved(child, True)
        return Resolved(ComputeOpSpec(name=name, subkind="cli", exe_data={"commands": {"linux": "true"}}), True)

    plan = await plan_wizard(spec, workdir=tmp_path, resolve_op=resolve, resolve_wizard=resolve)
    assert plan.needs == [] and "ask" not in resolved
