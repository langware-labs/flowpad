"""Phase 5: NotificationEnvelope.

WS payload + email payload are projections of the same struct so the two
channels cannot drift. Round-trip a Notification via from_envelope.
"""

from __future__ import annotations

import pytest

from flow_sdk.core.network.connection import Notification
from flow_sdk.flowpad_types.enums.entity_enums import CrudAction, NotificationType
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.notifications import NotificationEnvelope


_TARGET = TypeId(type="task", id="aaaa1111-2222-3333-4444-555555555550")


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_ws_payload_carries_target_and_event_data():
    env = NotificationEnvelope(
        notification_type=NotificationType.RESOURCE_ACTION,
        notification_subtype=CrudAction.CREATE,
        target=_TARGET,
        sender_id="alice",
        recipient_id="bob",
        title="Bob, you've got a new task",
        body_text="text body",
        metadata={"source_url": "https://example.com/p"},
        occurred_at="2026-05-01T00:00:00Z",
    )
    payload = env.as_ws_payload()
    assert payload["type"] == "task"
    assert payload["id"] == _TARGET.id
    assert payload["operation"] == CrudAction.CREATE
    ed = payload["data"]["event_data"]
    assert ed["target"] == str(_TARGET)
    assert ed["title"] == "Bob, you've got a new task"
    assert ed["metadata"]["source_url"] == "https://example.com/p"
    assert ed["schema_version"] == 1


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_email_payload_shares_title_with_ws():
    env = NotificationEnvelope(
        notification_type=NotificationType.RESOURCE_ACTION,
        notification_subtype=CrudAction.CREATE,
        target=_TARGET,
        sender_id="alice",
        recipient_id="bob",
        title="Bob, you've got a new task",
        body_text="text body",
        body_html="<p>html</p>",
        metadata={"source_url": "https://example.com/p"},
        occurred_at="2026-05-01T00:00:00Z",
    )
    ws = env.as_ws_payload()
    em = env.as_email_payload()
    assert em["subject"] == ws["data"]["event_data"]["title"]
    assert em["body_text"] == "text body"
    assert em["body_html"] == "<p>html</p>"
    assert em["metadata"]["target"] == str(_TARGET)


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_notification_target_accepts_typeid_via_model_validate():
    n = Notification.model_validate({"notification_target": str(_TARGET)})
    assert isinstance(n.notification_target, TypeId)
    assert n.notification_target.id == _TARGET.id


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_notification_from_envelope_round_trips_target():
    env = NotificationEnvelope(
        notification_type=NotificationType.RESOURCE_ACTION,
        notification_subtype=CrudAction.CREATE,
        target=_TARGET,
        sender_id="alice",
        recipient_id="bob",
        title="t",
        body_text="b",
    )
    n = Notification.from_envelope(env)
    assert isinstance(n.notification_target, TypeId)
    assert n.notification_target == _TARGET
    assert n.recipient_id == "bob"
    assert n.message == "b"
