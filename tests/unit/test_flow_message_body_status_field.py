"""Unit tests for the FlowMessage.body_status field.

Verifies default value, enum coercion from raw strings (so the bridge
inbound op-log handler can stuff a hub-shaped UPDATE payload straight
through), and serializer round-trip.

# do not increase timeout without approval
"""
from __future__ import annotations

import pytest

from flow_sdk.builtin.flow_message import BodyStatus, FlowMessage


pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


def test_default_is_na():
    fm = FlowMessage(text="t")
    assert fm.body_status == BodyStatus.NA


def test_enum_coerces_from_string():
    """Raw string values from the hub payload must round-trip into the enum.

    The bridge's data_op_msg(update) frames carry the field as a string;
    pydantic's str-enum coerces transparently. If this assertion breaks,
    the receiver-side state machine stops reacting to body_status flips."""
    fm = FlowMessage(text="t", body_status="uploading")
    assert fm.body_status == BodyStatus.UPLOADING

    fm2 = FlowMessage(text="t", body_status="ready")
    assert fm2.body_status == BodyStatus.READY


def test_invalid_string_rejected():
    """Unknown body_status values must fail validation, not silently coerce.

    This is what protects the receiver from a hub regression that ships a
    new status value the client doesn't understand — we'd rather error
    loudly than render in the wrong state."""
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        FlowMessage(text="t", body_status="bogus")


def test_serializer_roundtrip_preserves_value():
    """JSON round-trip preserves body_status as the raw string value."""
    fm = FlowMessage(text="t", body_status=BodyStatus.UPLOADING)
    data = fm.model_dump(mode="json")
    assert data["body_status"] == "uploading"

    fm2 = FlowMessage.model_validate(data)
    assert fm2.body_status == BodyStatus.UPLOADING


def test_body_status_independent_of_attachment():
    """body_status is hub-stamped, NOT derived from attachment[].

    A receiver might see a FM with attachments but body_status=NA briefly
    (between header CREATE and body_status UPDATE), or with body_status=READY
    and no attachments (legacy). The field is the source of truth, not
    has_body()."""
    fm = FlowMessage(text="t", body_status=BodyStatus.READY)
    assert fm.body_status == BodyStatus.READY
    assert fm.has_body() is False  # no attachments → has_body still False
