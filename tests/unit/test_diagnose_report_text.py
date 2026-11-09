"""A report that describes nothing is named as such; a diagnosis that found something leads with it."""

from __future__ import annotations

import pytest

from flow_sdk.app.actions.ask_for_help_action import bottom_line
from flow_sdk.diagnose.report_text import describes_a_problem, no_description_instruction
from flow_sdk.schema.data_spec.diagnose_spec import DiagnosisCause, DiagnosisSpec, DiagnosisStatus

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.mark.parametrize("text", ["", "   ", None, "hi9", "test", "help", "502", "!!!"])
def test_a_word_or_nothing_does_not_describe_a_problem(text) -> None:
    assert not describes_a_problem(text)


@pytest.mark.parametrize(
    "text",
    ["the home button does not work", "כפתור הבית לא עובד", "Traceback (most recent call last)", "it crashes"],
)
def test_a_sentence_or_a_pasted_error_describes_a_problem(text) -> None:
    assert describes_a_problem(text)


def test_the_agent_is_told_what_the_person_wrote_when_it_described_nothing() -> None:
    note = no_description_instruction("hi9")
    assert 'They wrote only "hi9".' in note
    assert "When no problem was described" in note
    assert "They wrote nothing." in no_description_instruction("")


def test_the_agent_is_told_nothing_extra_when_a_problem_was_described() -> None:
    assert no_description_instruction("the home button does not work") == ""


def test_an_unknown_cause_leads_with_what_the_diagnosis_found() -> None:
    diagnosis = DiagnosisSpec(
        status=DiagnosisStatus.UNRECOGNIZED,
        cause=DiagnosisCause.UNKNOWN,
        title="Home button reported broken: no fault found in the Home path; cause unknown",
    )
    assert bottom_line(diagnosis) == diagnosis.title


def test_an_unknown_cause_with_nothing_written_down_keeps_the_fixed_sentence() -> None:
    diagnosis = DiagnosisSpec(status=DiagnosisStatus.UNRECOGNIZED, cause=DiagnosisCause.UNKNOWN)
    assert bottom_line(diagnosis) == "The cause is unclear — Flowpad support can look into it."
