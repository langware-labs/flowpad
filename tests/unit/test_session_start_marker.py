"""The ``session_start`` marker — the guest's opening proposal on the carrier."""
import json

import pytest

from flow_sdk.builtin.flow_message import (
    SESSION_START_MARKER_KEY,
    Attachment,
    AttachmentType,
    FlowMessage,
    FlowMessageKind,
    derive_session_fields,
    session_start_settings,
)

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

SID = "a1a1a1a1-0000-4000-8000-00000000d001"


def _fm(preview):
    return FlowMessage(text="x", attachment=[
        Attachment(attachment_type=AttachmentType.PROMPT, data="run it"),
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"remote_worker_session-{SID}", prompt_preview=preview),
    ])


def test_round_trips_reply_policy():
    fm = _fm(json.dumps({SESSION_START_MARKER_KEY: {"reply_policy": "review"}}))
    assert session_start_settings(fm).reply_policy == "review"


def test_bare_carrier_is_no_proposal():
    assert session_start_settings(_fm(None)) is None


def test_non_json_and_wrong_shape_are_no_proposal():
    assert session_start_settings(_fm("not json")) is None
    assert session_start_settings(_fm(json.dumps({SESSION_START_MARKER_KEY: "review"}))) is None
    assert session_start_settings(_fm(json.dumps({"live_session_event": "approved"}))) is None


def test_unknown_keys_are_dropped_not_fatal():
    fm = _fm(json.dumps({SESSION_START_MARKER_KEY: {"reply_policy": "auto", "vendor_only": 1}}))
    assert session_start_settings(fm).reply_policy == "auto"


def test_start_marker_keeps_kind_user():
    fm = _fm(json.dumps({SESSION_START_MARKER_KEY: {"reply_policy": "auto"}}))
    derive_session_fields(fm)
    assert fm.kind == FlowMessageKind.USER
    assert fm.remote_worker_session_id == SID


def test_spec_kind_is_registered():
    from flow_sdk.fs_store.schema_registry import SchemaRegistry
    from flow_sdk.schema.data_spec._kinds import register_builtin_kinds
    from flow_sdk.schema.data_spec.session_spec import SessionStartSettings
    register_builtin_kinds()
    assert SchemaRegistry.kind_type("session.start") is SessionStartSettings
