"""A ``decision`` op: one Decision API call, judged against the op's requirements.

The API is doubled (``tests/utils/decision_double.py``); the runner, the wizard and the
judging run for real. Each test is one outcome: met, not met, unavailable, and the op as a
wizard step that binds, branches and stops.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.core.compute_op.decision import decide_op, judge
from flow_sdk.core.compute_op.runner import run_op
from flow_sdk.core.wizard.runner import Resolved, run_wizard
from flow_sdk.schema.data_spec.compute_op_spec import CliOp, ComputeOpSpec, DecisionOp, OpSubkind, Require
from flow_sdk.schema.data_spec.decision_spec import (
    ChoiceAnswer,
    DecisionResult,
    ScoreAnswer,
    YesNoAnswer,
    YesNoQuestion,
)
from flow_sdk.schema.data_spec.returned_value_spec import DecisionVerdict, ExitCode
from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec, WizardStepSpec

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


class Note(DataSpec):
    text: str


REFUND = DecisionOp.from_sentence(
    "asks for a refund", question=YesNoQuestion(instructions="Is this true of `text`: asks for a refund?")
)
ROUTE = DecisionOp(
    questions={
        "team": {"type": "choice", "instructions": "Where does `text` go?", "options": {"billing": "money", "bug": "broken"}},
        "urgency": {"type": "score", "instructions": "How urgent is `text`?", "levels": ["routine", "today", "urgent"]},
    },
    require={"team": Require(choice="billing"), "urgency": Require(at_least="today")},
)


def test_a_sentence_is_one_yes_no_question_at_85():
    assert list(REFUND.questions) == ["match"]
    assert REFUND.require["match"].yes == 0.85
    assert REFUND.sentence == "asks for a refund"


def test_a_requirement_must_name_a_question_of_its_kind():
    with pytest.raises(ValueError, match="names no question"):
        DecisionOp(questions=REFUND.questions, require={"other": Require(yes=0.5)})
    with pytest.raises(ValueError, match="needs a choice question"):
        DecisionOp(questions=REFUND.questions, require={"match": Require(choice="x")})
    with pytest.raises(ValueError, match="exactly one of"):
        Require(yes=0.5, no=0.5)


def test_judge_reads_every_requirement():
    result = DecisionResult(answers={
        "team": ChoiceAnswer(choice="billing", confidence=0.97, probabilities={"billing": 0.97, "bug": 0.03}),
        "urgency": ScoreAnswer(score=1.0, confidence=0.7),
    })
    verdict = judge(ROUTE, result)
    assert verdict.met and verdict.exit_code is ExitCode.OK
    assert verdict.confidence == 0.7, "the least sure requirement decides how sure the verdict is"
    assert verdict.value == {"team": "billing", "urgency": "today"}

    low = DecisionResult(answers={**result.answers, "urgency": ScoreAnswer(score=0.0, confidence=0.9)})
    verdict = judge(ROUTE, low)
    assert not verdict.met and verdict.exit_code is ExitCode.NOT_YET and verdict.ran
    assert verdict.reason == "urgency was 'routine', needed at least 'today'"

    verdict = judge(REFUND, DecisionResult(answers={"match": YesNoAnswer(probability=0.61)}))
    assert not verdict.met and verdict.reason == "match was 0.61, needed yes ≥ 0.85"
    assert verdict.value is True, "the plain answer leans yes; met is the verdict, value is the answer"


async def test_decide_op_asks_once_and_is_met(decision_double):
    verdict = await decide_op(REFUND, Note(text="I was charged twice"))
    assert isinstance(verdict, DecisionVerdict) and verdict.met and verdict.confidence == 0.9
    assert verdict.reason == "asks for a refund" and verdict.endpoint.startswith("api_endpoint-")
    assert len(decision_double["invoked"]) == 1


async def test_decide_op_not_met_is_an_answer(decision_double):
    decision_double["answers"]["match"] = 0.2
    verdict = await decide_op(REFUND, Note(text="Here is the invoice"))
    assert not verdict.met and verdict.ran and verdict.unavailable is None


async def test_decide_op_unavailable_is_not_met_and_says_why(decision_double):
    decision_double["status"] = 429
    verdict = await decide_op(REFUND, Note(text="anything"))
    assert not verdict.met and not verdict.ran and verdict.unavailable == "rate_limited"


async def test_run_op_decides_about_the_named_scope_value(decision_double, tmp_path: Path):
    spec = ComputeOpSpec(name="gate", subkind=OpSubkind.DECISION, exe_data=REFUND)
    answer = await run_op(spec, trusted=True, workdir=tmp_path, values={"STATE": Note(text="refund me")})
    assert isinstance(answer, DecisionVerdict) and answer.met
    missing = await run_op(spec, trusted=True, workdir=tmp_path, values={})
    assert missing.exit_code is ExitCode.NOT_APPLICABLE and "nothing named 'STATE'" in missing.detail


async def test_as_a_step_it_binds_branches_and_stops(decision_double, tmp_path: Path):
    which = DecisionOp(questions={"team": ROUTE.questions["team"]}, require={"team": Require(choice="billing")})
    gate = ComputeOpSpec(name="which-team", subkind=OpSubkind.DECISION, exe_data=which)
    marker = ComputeOpSpec(name="mark", subkind=OpSubkind.CLI, exe_data=CliOp(commands={"darwin": "touch ran.txt", "linux": "touch ran.txt"}))
    ops = {"which-team": gate, "mark": marker}

    async def resolve(name):
        return Resolved(ops[name], trusted=True)

    wizard = WizardSpec(name="route", steps=[
        WizardStepSpec(id="route", ref="which-team", bind="TEAM", on_fail="stop"),
        WizardStepSpec(id="billing", ref="mark", when={"TEAM": "billing"}),
        WizardStepSpec(id="bugs", ref="mark", when={"TEAM": "bug"}),
    ])
    result = await run_wizard(wizard, trusted=True, workdir=tmp_path, resolve_op=resolve, platform="darwin",
                              inputs={"STATE": Note(text="charged twice")})
    assert result.ok and result.steps["billing"].ran
    assert result.steps["bugs"].exit_code is ExitCode.NOT_APPLICABLE and "TEAM is" in result.steps["bugs"].detail
    assert (tmp_path / "ran.txt").exists()

    decision_double["answers"]["team"] = "bug"  # the gate is not met
    result = await run_wizard(wizard, trusted=True, workdir=tmp_path, resolve_op=resolve, platform="darwin",
                              inputs={"STATE": Note(text="charged twice")})
    assert result.ok and result.stopped_at == "route" and "billing" not in result.steps
    assert not result.steps["route"].met and result.ran is True, "the question was asked — that is work"
