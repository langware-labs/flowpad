"""A form that travels on a message, and its answers.

The sender's message carries a ``message_form-<form_id>`` TYPE_ID attachment whose
``prompt_preview`` holds a ``MessageForm``. The receiver fills it in and Submit posts a
reply carrying a ``form_answers-<form_id>`` attachment holding ``FormAnswers``. Changing
the answers posts another such reply; the latest one is the answer. Neither is an entity.

A field with a ``default`` is pre-filled; one without (and not ``optional``) must be filled.
"""

from __future__ import annotations

import datetime
import json
from typing import Any, ClassVar, Literal, Optional

from pydantic import model_validator

from flow_sdk.schema.data_spec.spec import DataSpec

MESSAGE_FORM_TYPE = "message_form"
FORM_ANSWERS_TYPE = "form_answers"

FieldType = Literal["text", "long_text", "number", "date", "one", "many", "yesno", "buttons", "select", "file"]
_CHOICE = ("one", "many", "buttons", "select")


class FormField(DataSpec):
    """One question. ``one``/``buttons``/``select`` pick one option, ``many`` several."""

    id: str
    label: str
    type: FieldType = "text"
    options: Optional[list[str]] = None
    default: Any = None
    optional: bool = False
    min: Optional[float] = None
    max: Optional[float] = None
    hint: Optional[str] = None

    @model_validator(mode="after")
    def _fits(self) -> "FormField":
        if self.type in _CHOICE and not self.options:
            raise ValueError(f"field {self.id!r}: a {self.type} field needs options")
        if self.default is not None:
            problem = field_problem(self, self.default)
            if problem:
                raise ValueError(f"field {self.id!r}: default {problem}")
        return self


class MessageForm(DataSpec):
    """The questions a message asks, answered with one Submit."""

    spec_kind: ClassVar[str] = "message.form"

    form_id: str
    title: str
    fields: list[FormField]

    @model_validator(mode="after")
    def _unique(self) -> "MessageForm":
        ids = [f.id for f in self.fields]
        if not ids:
            raise ValueError("a form needs at least one field")
        if len(set(ids)) != len(ids):
            raise ValueError("field ids must be unique")
        return self


class FormAnswers(DataSpec):
    """What the receiver submitted. ``changed`` lists the fields that differ from the
    previous answers (or, the first time, from the defaults)."""

    spec_kind: ClassVar[str] = "message.form_answers"

    form_id: str
    values: dict[str, Any]
    changed: list[str] = []
    #: The answers message this one replaces, when the receiver changed their answers.
    supersedes: Optional[str] = None


def field_problem(field: FormField, value: Any) -> Optional[str]:
    """Why ``value`` does not fit ``field`` — ``None`` when it does."""
    t = field.type
    if t == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return "must be a number"
        if field.min is not None and value < field.min:
            return f"must be ≥ {field.min:g}"
        if field.max is not None and value > field.max:
            return f"must be ≤ {field.max:g}"
    elif t == "date":
        try:
            datetime.date.fromisoformat(str(value))
        except ValueError:
            return "must be a date (YYYY-MM-DD)"
    elif t == "yesno":
        if not isinstance(value, bool):
            return "must be yes or no"
    elif t == "many":
        if not isinstance(value, list) or any(v not in (field.options or []) for v in value):
            return f"must be some of {field.options}"
    elif t in _CHOICE:
        if value not in (field.options or []):
            return f"must be one of {field.options}"
    elif not isinstance(value, str):
        return "must be text"
    return None


def _empty(value: Any) -> bool:
    return value is None or value == "" or value == []


def check_answers(form: MessageForm, values: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """The values to send (defaults filled in) and the problems, one line per field."""
    known = {f.id for f in form.fields}
    problems = [f"{k}: not a field of this form" for k in values if k not in known]
    clean: dict[str, Any] = {}
    for f in form.fields:
        value = values.get(f.id, f.default)
        if _empty(value):
            if not f.optional:
                problems.append(f"{f.label}: needs an answer")
            continue
        problem = field_problem(f, value)
        if problem:
            problems.append(f"{f.label}: {problem}")
        else:
            clean[f.id] = value
    return clean, problems


def changed_fields(form: MessageForm, values: dict[str, Any], previous: Optional[dict[str, Any]]) -> list[str]:
    """Fields that differ from the previous answers — or, first time, from a default the sender set."""
    base = previous if previous is not None else {f.id: f.default for f in form.fields}
    return [f.id for f in form.fields
            if (previous is not None or f.default is not None) and values.get(f.id) != base.get(f.id)]


def _carried(attachments: Any, kind: str, model):
    from flow_sdk.builtin.flow_message import carried_value  # noqa: PLC0415 — builtin imports data_spec

    found = carried_value(attachments, kind)
    if found is None:
        return None
    try:
        return model.model_validate(found[1])
    except ValueError:
        return None


def form_in(attachments: Any) -> Optional[MessageForm]:
    """The form a message carries, if any. A malformed one reads as none."""
    return _carried(attachments, MESSAGE_FORM_TYPE, MessageForm)


def answers_in(attachments: Any) -> Optional[FormAnswers]:
    return _carried(attachments, FORM_ANSWERS_TYPE, FormAnswers)


def _attachment(kind: str, form_id: str, payload: dict) -> dict:
    """The attachment dict ``handle_add_message`` adopts (``body["attachment"]``)."""
    return {"attachment_type": "type_id", "data": f"{kind}-{form_id}", "prompt_preview": json.dumps(payload)}


def form_attachment(form: MessageForm) -> dict:
    return _attachment(MESSAGE_FORM_TYPE, form.form_id, form.model_dump(mode="json", exclude_none=True))


def answers_attachment(answers: FormAnswers) -> dict:
    return _attachment(FORM_ANSWERS_TYPE, answers.form_id, answers.model_dump(mode="json", exclude_none=True))


def form_summary(form: MessageForm) -> str:
    """``<title> · N questions · k to fill`` — the one line a reader (or the CLI) shows."""
    to_fill = sum(1 for f in form.fields if f.default is None and not f.optional)
    tail = f" · {to_fill} to fill" if to_fill else ""
    return f"{form.title} · {len(form.fields)} questions{tail}"


def answers_line(form: Optional[MessageForm], answers: FormAnswers) -> str:
    """``label=value; …`` in the form's order — what an agent reads."""
    labels = {f.id: f.label for f in form.fields} if form else {}
    order = [f.id for f in form.fields] if form else list(answers.values)
    parts = []
    for fid in order:
        if fid not in answers.values:
            continue
        v = answers.values[fid]
        shown = ", ".join(map(str, v)) if isinstance(v, list) else ("yes" if v is True else "no" if v is False else v)
        mark = " (changed)" if fid in answers.changed else ""
        parts.append(f"{fid}={shown}{mark}" if not labels else f"{labels[fid]}={shown}{mark}")
    return "; ".join(parts)
