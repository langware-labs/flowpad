"""``if`` and ``then`` travel: file → row → file, and the pieces that read them."""

from __future__ import annotations

import json

import pytest

from flow_sdk.assets.types.trigger import row_fields
from flow_sdk.automations.describe import describe_then
from flow_sdk.automations.fingerprint import spec_hash
from flow_sdk.automations.spec_file import apply_patch, gate_doc, rewrite, validate
from flow_sdk.automations.then import AGENT_STEP, as_wizard
from flow_sdk.builtin.trigger import Trigger
from flow_sdk.schema.data_spec.compute_op_spec import AgentOp, DecisionOp
from flow_sdk.schema.data_spec.trigger_spec import ThenSpec, TriggerSpec
from tests.pytest_plugin import async_context

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

DOC = {
    "name": "Refund requests → Billing helper",
    "tag": {"on": "stream_inbox.*.message.projected", "scope": ["data_source:7a1e"]},
    "if": "asks for a refund or disputes a charge",
    "then": {"run_agent": {"agent": "agent-1", "prompt": "Draft the reply."}},
}


def test_the_sentence_becomes_the_subjects_question_on_the_row():
    spec = TriggerSpec.model_validate(DOC)
    fields = row_fields(spec)
    assert fields["gate"] == {"sentence": DOC["if"]}, "the file's words travel as they are"
    gate = DecisionOp.model_validate(Trigger(**fields).gate)  # the row words them on construction
    assert gate.sentence == "asks for a refund or disputes a charge" and gate.input == "MESSAGE"
    assert "`text`, `subject`, from `sender`" in gate.questions["match"].instructions
    assert gate.require["match"].yes == 0.85
    assert fields["then"] == {"run_agent": {"agent": "agent-1", "prompt": "Draft the reply."}}
    assert fields["actions"] == []


def test_the_long_form_is_kept_as_written():
    long = {**DOC, "if": {"questions": {"refund": {"type": "yes_no", "instructions": "Does `text` ask for a refund?"}},
                          "require": {"refund": {"yes": 0.9}}}}
    gate = row_fields(TriggerSpec.model_validate(long))["gate"]
    assert gate["require"]["refund"]["yes"] == 0.9 and gate["sentence"] == ""
    assert gate_doc(gate) == {"questions": gate["questions"], "require": gate["require"], "input": "STATE"}


def test_a_sentence_round_trips_as_a_sentence():
    fields = row_fields(TriggerSpec.model_validate(DOC))
    assert gate_doc(fields["gate"]) == "asks for a refund or disputes a charge", "unworded, still the sentence"
    gate = Trigger(**fields).gate
    assert gate_doc(gate) == "asks for a refund or disputes a charge"
    doc = apply_patch({"name": "x", "tag": {"on": "stream_inbox.*.message.projected"}}, {"gate": gate, "then": DOC["then"]})
    assert doc["if"] == DOC["if"] and doc["then"] == DOC["then"] and "actions" not in doc
    validate(doc)


def test_then_and_actions_are_one_or_the_other():
    with pytest.raises(ValueError, match="`then` or `actions`, not both"):
        TriggerSpec.model_validate({**DOC, "actions": [{"callback": "x"}]})
    with pytest.raises(ValueError, match="exactly one of"):
        ThenSpec.model_validate({"ref": "a", "run_script": "b"})


def test_the_sugar_expands_to_one_agent_step_handed_the_state():
    then = ThenSpec.model_validate(DOC["then"])
    wizard, ops = as_wizard(then, name="refunds", scope_key="MESSAGE")
    (step,) = wizard.steps
    assert step.id == AGENT_STEP and step.ref in ops
    exe = ops[step.ref].exe_data
    assert isinstance(exe, AgentOp) and exe.agent == "agent-1" and exe.input == "MESSAGE" and exe.launch_context == "LAUNCH"


def test_a_fire_with_no_state_gives_the_agent_no_input():
    """A rule with no gate has no subject state in scope: the sugar's agent runs with no input rather
    than naming a value that is not there (which would answer not-applicable and launch nothing)."""
    wizard, ops = as_wizard(ThenSpec.model_validate(DOC["then"]), name="refunds")
    exe = ops[wizard.steps[0].ref].exe_data
    assert isinstance(exe, AgentOp) and exe.input == ""


def test_the_history_row_keeps_an_outline_of_the_wizard_never_its_output():
    from flow_sdk.schema.data_spec.returned_value_spec import CliResult, PromptResult, WizardResult

    result = WizardResult.satisfied("done", steps={
        "say": CliResult.satisfied("ok", stdout="x" * 5000),
        "handle": PromptResult.satisfied("y" * 900, executor="agentic_process-11111111-1111-4111-8111-111111111111"),
    })
    outline = result.outline()
    assert outline["exit_code"] == 0 and list(outline["steps"]) == ["say", "handle"]
    assert outline["steps"]["say"] == {"exit_code": 0, "detail": "ok"}
    assert outline["steps"]["handle"]["executor"].startswith("agentic_process-") and len(outline["steps"]["handle"]["detail"]) == 300
    assert "stdout" not in json.dumps(outline) and result.first_executor() == outline["steps"]["handle"]["executor"]


def test_the_gate_is_read_as_its_op_in_one_place():
    worded = Trigger(name="r", trigger_type="tag", tag_pattern="stream_inbox.*.message.projected", gate={"sentence": "asks for a refund"})
    assert isinstance(worded.gate_op, DecisionOp) and DecisionOp.is_sentence_form(worded.gate)
    assert Trigger(name="r", trigger_type="tag", tag_pattern="app.ready", gate={"sentence": "x"}).gate_op is None, "nothing worded it"
    assert Trigger(name="r", trigger_type="tag", tag_pattern="app.ready").gate_op is None
    stricter = {**worded.gate, "require": {"match": {"yes": 0.95}}}
    assert not DecisionOp.is_sentence_form(stricter) and gate_doc(stricter)["require"]["match"]["yes"] == 0.95


@async_context
async def test_a_missing_decision_api_is_its_own_finding(monkeypatch):
    """The rule's `if` is fine; what is missing is on this machine — so the screen can say exactly that."""
    import flow_sdk.instance_settings.api_endpoint as api_endpoint
    from flow_sdk.automations.check import check

    async def none_here():
        return []

    monkeypatch.setattr(api_endpoint, "decision_endpoints", none_here)
    rule = Trigger(name="r", trigger_type="tag", tag_pattern="stream_inbox.*.message.projected",
                   gate={"sentence": "asks for a refund"}, then=DOC["then"])
    found = {f.area: f for f in (await check(rule)).findings}
    assert "if" not in found and found["decider"].ok is False and "Decision API to decide" in found["decider"].message

    unworded = Trigger(name="r", trigger_type="tag", tag_pattern="app.ready", gate={"sentence": "x"}, then=DOC["then"])
    found = {f.area: f for f in (await check(unworded)).findings}
    assert found["if"].ok is False and "decider" not in found


def test_the_last_hour_count_reads_raw_rows():
    from flow_sdk.automations.runs import started_since

    rows = [
        {"hook_event": "tag_fire", "trigger": True, "ts": "2026-10-10T12:30:00+00:00"},
        {"hook_event": "tag_fire_done", "trigger": True, "ts": "2026-10-10T12:30:05+00:00"},   # the same run's outcome
        {"hook_event": "tag_fire", "trigger": True, "is_test": True, "ts": "2026-10-10T12:31:00+00:00"},
        {"hook_event": "tag_declined", "trigger": False, "reason_code": "decision_no", "ts": "2026-10-10T12:32:00+00:00"},
        {"hook_event": "schedule_fire", "trigger": True, "ts": "2026-10-10T12:40:00+00:00"},
        {"hook_event": "tag_fire", "trigger": True, "ts": "2026-10-10T10:00:00+00:00"},        # older than the floor
    ]
    assert started_since(rows, "2026-10-10T12:00:00+00:00") == 2


def test_inline_steps_carry_their_ops():
    then = ThenSpec.model_validate({"steps": [{"id": "say", "ref": "say"}],
                                    "ops": {"say": {"subkind": "cli", "exe_data": {"commands": {"darwin": "echo hi"}}}}})
    wizard, ops = as_wizard(then, name="w", scope_key="STATE")
    assert [s.id for s in wizard.steps] == ["say"] and ops["say"].name == "say"


def test_the_fingerprint_moves_with_the_gate_and_the_then():
    a = Trigger(name="r", trigger_type="tag", tag_pattern="x.*", gate={"sentence": "a"}, then=DOC["then"])
    b = Trigger(name="r", trigger_type="tag", tag_pattern="x.*", gate={"sentence": "b"}, then=DOC["then"])
    c = Trigger(name="r", trigger_type="tag", tag_pattern="x.*", gate={"sentence": "a"},
                then={"run_agent": {"agent": "agent-1", "prompt": "Other."}})
    assert spec_hash(a) != spec_hash(b) != spec_hash(c) and spec_hash(a) != spec_hash(c)


@async_context
async def test_describe_then_reads_the_sugar():
    row = Trigger(name="r", trigger_type="tag", tag_pattern="x.*", then=DOC["then"])
    (part,) = await describe_then(row)
    assert part.kind == "run_agent" and part.prompt == "Draft the reply." and part.target == "agent-1"


@async_context
async def test_rewrite_keeps_if_and_then_in_the_file(tmp_path):
    from flow_sdk.builtin.agent_schedule import _index

    folder = tmp_path / "agentic-assets" / "trigger" / "refunds"
    folder.mkdir(parents=True)
    (folder / "trigger.json").write_text(json.dumps(DOC))
    row = await _index(folder)
    assert row.gate["sentence"] == DOC["if"] and row.then == DOC["then"]

    fresh = await rewrite(row, {"name": "Refunds", "then": {"run_agent": {"agent": "agent-1", "prompt": "Reply kindly."}}})
    on_disk = json.loads((folder / "trigger.json").read_text())
    assert on_disk["if"] == DOC["if"] and on_disk["then"]["run_agent"]["prompt"] == "Reply kindly."
    assert "actions" not in on_disk and fresh.then["run_agent"]["prompt"] == "Reply kindly."


def test_a_row_words_its_sentence_on_construction():
    """The builder sends `gate: {sentence}` (a file's string `if` arrives the same way); the row words it
    the moment it is built, so create / update / check / decide_spec / the index all gate alike."""
    from flow_sdk.automations.check import trigger_from_spec

    fields = {"name": "r", "trigger_type": "tag", "tag_pattern": "stream_inbox.*.message.projected",
              "gate": {"sentence": "asks for a refund"}, "then": DOC["then"]}
    worded = Trigger(**fields).gate
    assert worded["sentence"] == "asks for a refund" and worded["input"] == "MESSAGE"
    assert "asks for a refund" in worded["questions"]["match"]["instructions"]
    assert trigger_from_spec(fields).gate == worded
    assert Trigger(**{**fields, "gate": worded}).gate == worded, "a worded gate stands"
    assert Trigger(name="r", trigger_type="tag", tag_pattern="app.ready", gate={"sentence": "x"}).gate == {"sentence": "x"}, "no subject, kept as is"
