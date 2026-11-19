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


def test_every_door_checks_answers_against_their_form():
    from flow_sdk.builtin.flow_message import check_values, value_attachment

    form = MessageForm.model_validate(FORM)
    carried = {("message_form", "f1"): form.model_dump(mode="json")}

    def find2(prefix, vid):
        return carried.get((prefix, vid))

    def answers(values):
        return [answers_attachment(FormAnswers(form_id="f1", values=values))]

    assert check_values(answers({"on": "2026-11-06"}), find=find2) == []
    assert check_values(answers({"on": "x", "tenant": "nope"}), find=find2) == [
        "Tenant: must be one of ['cloudtest', 'local']",
        "Switch on: must be a date (YYYY-MM-DD)",
    ]
    assert check_values(answers({"on": "2026-11-06"}), find=lambda p, v: None) == ["form f1: not in this conversation"]
    assert check_values([value_attachment("form_answers", "f1", {"values": {}})], find=find2)[0].startswith("form_answers:")
    broken = {"attachment_type": "type_id", "data": "form_answers-f1", "prompt_preview": "not json"}
    assert check_values([broken], find=find2) == ["form_answers: its value is missing or not a JSON object"]
    # a value of a kind no door checks, and an ordinary entity reference, pass untouched
    assert check_values([value_attachment("process_call", "c1", {"x": 1}), {"attachment_type": "type_id", "data": "skill-s1"}], find=find2) == []


def test_the_cli_derives_what_changed_from_the_previous_answers():
    def line(values, previous):
        att = answers_attachment(FormAnswers(form_id="f1", values=values))
        return _form_attachment_line({"type": "type_id", "data": att["data"], "prompt_preview": att["prompt_preview"]}, previous)

    previous: dict = {}
    assert line({"tenant": "local", "qa": True}, previous) == "  ✅ answers to form f1: tenant=local; qa=yes"
    assert line({"tenant": "cloudtest", "qa": True}, previous) == "  ✅ answers to form f1: tenant=cloudtest (changed); qa=yes"
