"""A form on a message and its answers (``message_form_spec``)."""

import pytest
from pydantic import ValidationError

from flow_sdk.cli.commands.conversation_cmd import _form_attachment_line
from flow_sdk.schema.data_spec.message_form_spec import (
    FormAnswers,
    MessageForm,
    answers_attachment,
    answers_in,
    changed_fields,
    check_answers,
    form_attachment,
    form_in,
)

FORM = {
    "form_id": "f1",
    "title": "Before I switch",
    "fields": [
        {"id": "tenant", "label": "Tenant", "type": "one", "options": ["cloudtest", "local"], "default": "cloudtest"},
        {"id": "homes", "label": "Test homes", "type": "number", "min": 0, "max": 20, "default": 5},
        {"id": "on", "label": "Switch on", "type": "date"},
        {"id": "qa", "label": "Run QA", "type": "yesno", "default": True},
        {"id": "svc", "label": "Services", "type": "many", "options": ["a", "b"], "default": ["a"]},
        {"id": "note", "label": "Note", "type": "long_text", "optional": True},
    ],
}


def test_default_must_fit_its_field():
    bad = {**FORM, "fields": [{"id": "x", "label": "X", "type": "number", "max": 3, "default": 9}]}
    with pytest.raises(ValidationError, match="default must be ≤ 3"):
        MessageForm.model_validate(bad)
    with pytest.raises(ValidationError, match="needs options"):
        MessageForm.model_validate({**FORM, "fields": [{"id": "x", "label": "X", "type": "one"}]})


def test_a_field_without_default_must_be_filled_and_defaults_are_kept():
    form = MessageForm.model_validate(FORM)
    clean, problems = check_answers(form, {})
    assert problems == ["Switch on: needs an answer"]
    clean, problems = check_answers(form, {"on": "2026-11-06", "tenant": "local"})
    assert problems == []
    assert clean == {"tenant": "local", "homes": 5, "on": "2026-11-06", "qa": True, "svc": ["a"]}
    _, problems = check_answers(form, {"on": "tomorrow", "homes": 50, "tenant": "x", "bogus": 1})
    assert len(problems) == 4


def test_changed_is_against_defaults_then_against_the_previous_answers():
    form = MessageForm.model_validate(FORM)
    first = {"tenant": "local", "homes": 5, "on": "2026-11-06", "qa": True, "svc": ["a"]}
    assert changed_fields(form, first, None) == ["tenant"]  # a filled no-default field is not a change
    assert changed_fields(form, {**first, "homes": 7}, first) == ["homes"]


def test_round_trip_on_attachments_and_the_cli_lines():
    form = MessageForm.model_validate(FORM)
    att = form_attachment(form)
    assert att["data"] == "message_form-f1"
    assert form_in([att]) == form
    ans = FormAnswers(form_id="f1", values={"tenant": "local", "qa": False}, changed=["tenant"])
    att2 = answers_attachment(ans)
    assert answers_in([att2]) == ans
    line = _form_attachment_line({"type": "type_id", "data": att["data"], "prompt_preview": att["prompt_preview"]})
    assert "6 questions · 1 to fill" in line and "on:date=?" in line and "note:long_text," not in line
    line2 = _form_attachment_line({"type": "type_id", "data": att2["data"], "prompt_preview": att2["prompt_preview"]})
    assert line2 == "  ✅ answers to form f1: tenant=local (changed); qa=no"
