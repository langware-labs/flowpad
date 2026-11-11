"""Payload accessors read an item the way ``envelope_of``'s old ``getattr`` fallbacks did.

Every ``Payload`` subclass reachable — core and every shipped driver's — is built twice (only the
required fields, and every field filled) and its accessors are compared with the old duck-typed
logic, kept here as the oracle.
"""

from __future__ import annotations

import enum
import types
import typing
from datetime import datetime, timezone
from typing import Any

import pytest
from pydantic import BaseModel

from flow_sdk.ingest.driver_registry import load_driver_value_kinds
from flow_sdk.ingest.envelope_lift import envelope_of, kind_of
from flow_sdk.sources.values.items import EmailMessageData, Payload
from flow_sdk.sources.values.origin import CloudOrigin

WHEN = datetime(2026, 10, 20, 9, 30, tzinfo=timezone.utc)


def _old(data: Any) -> dict:
    """The accessors as ``envelope_of`` computed them before they existed."""
    person = getattr(data, "sender", None) or getattr(data, "author", None)
    when = getattr(data, "sent_at", None) or getattr(data, "published_at", None)
    conversation = getattr(data, "conversation", None)
    in_reply_to = getattr(data, "in_reply_to", None)
    return {
        "title": getattr(data, "subject", None) or getattr(data, "title", None) or "",
        "text": getattr(data, "text", None) or "",
        "at": when.isoformat() if when else None,
        "author_id": person.origin.key if person else None,
        "author_name": (person.name if person else None) or getattr(data, "byline", None),
        "permalink": getattr(data, "url", None),
        "thread": conversation.key if conversation is not None else None,
        "reply_to": in_reply_to.key if in_reply_to is not None else None,
    }


def _new(data: Payload) -> dict:
    return {
        "title": data.item_title,
        "text": data.item_text,
        "at": data.item_at,
        "author_id": data.item_author_id,
        "author_name": data.item_author_name,
        "permalink": data.item_permalink,
        "thread": data.item_thread,
        "reply_to": data.item_reply_to,
    }


def _subclasses(cls: type) -> list[type]:
    out: list[type] = []
    for sub in cls.__subclasses__():
        out.append(sub)
        out.extend(_subclasses(sub))
    return out


def _payload_classes() -> list[type]:
    load_driver_value_kinds()
    import flow_sdk.sources.folder  # noqa: F401, PLC0415 — LocalFileData
    import flow_sdk.sources.values.call  # noqa: F401, PLC0415 — VoiceTurnData

    seen: dict[str, type] = {}
    for cls in [Payload, *_subclasses(Payload)]:
        seen.setdefault(f"{cls.__module__}.{cls.__qualname__}", cls)
    return list(seen.values())


def _value(annotation: Any, name: str, full: bool) -> Any:
    origin = typing.get_origin(annotation)
    if origin is typing.Annotated:
        return _value(typing.get_args(annotation)[0], name, full)
    if origin in (typing.Union, types.UnionType):
        args = [a for a in typing.get_args(annotation) if a is not type(None)]
        return _value(args[0], name, full) if args else None
    if origin in (tuple, list):
        return () if origin is tuple else []
    if origin is dict or annotation is dict:
        return {"k": "v"}
    if annotation is str:
        return f"{name} value"
    if annotation is bool:
        return True
    if annotation is int:
        return 3
    if annotation is datetime:
        return WHEN
    if isinstance(annotation, type) and issubclass(annotation, enum.Enum):
        return next(iter(annotation))
    if annotation is CloudOrigin:
        return CloudOrigin(kind="test", namespace="ns", key=f"{name}-key", url=f"https://x/{name}" if full else None)
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        return _build(annotation, full)
    raise LookupError(annotation)


def _build(cls: type, full: bool) -> Any:
    values: dict[str, Any] = {}
    for name, field in cls.model_fields.items():
        if not full and not field.is_required():
            continue
        try:
            values[name] = _value(field.annotation, name, full)
        except LookupError:
            if field.is_required():
                raise
    return cls(**values)


CLASSES = _payload_classes()


def test_every_driver_payload_is_reached():
    names = {c.__name__ for c in CLASSES}
    for expected in ("SlackMessageData", "GmailMessageData", "JiraIssueData", "TelegramMessageData", "VoiceTurnData"):
        assert expected in names


@pytest.mark.parametrize("full", [False, True], ids=["required", "full"])
@pytest.mark.parametrize("cls", CLASSES, ids=lambda c: c.__name__)
def test_accessors_match_old_getattr_logic(cls, full):
    data = _build(cls, full)
    assert _new(data) == _old(data)


@pytest.mark.parametrize("cls", CLASSES, ids=lambda c: c.__name__)
def test_accessors_never_serialize(cls):
    dumped = _build(cls, True).model_dump()
    assert not any(key.startswith("item_") for key in dumped)


@pytest.mark.parametrize("cls", CLASSES, ids=lambda c: c.__name__)
def test_envelope_of_unchanged(cls):
    data = _build(cls, True)
    try:
        kind_of(data)
    except TypeError:
        pytest.skip("not a record payload")
    for url in (None, "https://origin/x"):
        item = types.SimpleNamespace(origin=CloudOrigin(kind="test", namespace="ns", key="k", url=url), data=data)
        env = envelope_of(item, data_source_id="ds", provider="p")
        old = _old(data)
        assert (env.name, env.body, env.occurred_at) == (old["title"], old["text"], old["at"])
        assert (env.author_external_id, env.author_display) == (old["author_id"], old["author_name"])
        assert env.permalink == (url or old["permalink"])
        assert (env.thread_key, env.reply_to_external_id) == (old["thread"], old["reply_to"])


@pytest.mark.parametrize(
    ("subject", "thread"),
    [("Re: Hello", "hello"), ("FW: re: Hello  ", "hello"), ("hello", "hello"), ("[team] Re: Fwd: Plan  B", "plan b"), (None, "")],
)
def test_email_subject_thread_golden(subject, thread):
    assert EmailMessageData(subject=subject).subject_thread == thread


def test_optional_none_fields_fall_back_like_before():
    data = EmailMessageData(subject="", text=None)
    assert _new(data) == _old(data)
    assert data.item_title == "" and data.item_thread is None
