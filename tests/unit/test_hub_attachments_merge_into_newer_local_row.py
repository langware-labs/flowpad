"""A message synced before its viewer could see its attachments shows them once the hub sends them.

A help-desk ticket's files are the hub's to give once a staff member has picked the ticket up. The row
the staff member's machine first stored has none; any local save after that stamps it newer than the
hub's clock, so the staleness gate called it current and the attachments the hub sends after pickup
were never merged (the files sat unpacked on disk, the message showed none).

# do not increase timeout without approval
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from flow_sdk.app.actions import flow_message_action as fma
from flow_sdk.builtin.flow_message import FlowMessage

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

_FM_ID = "aaaaaaaa-0000-4000-8000-000000000abc"
_CONV_ID = "bbbbbbbb-0000-4000-8000-000000000def"
_HUB_CLOCK = datetime(2026, 11, 8, 15, 19, 21, tzinfo=timezone.utc)


def _hub_message(attachment: list[dict]) -> dict:
    return {
        "id": _FM_ID,
        "type": "flow_message",
        "text": "my app is broken",
        "conversation_id": _CONV_ID,
        "sender_id": "cccccccc-0000-4000-8000-000000000001",
        "sender_name": "Alice",
        "updated_date": _HUB_CLOCK.isoformat(),
        "attachment": attachment,
    }


_TYPE_ID_ATTACHMENT = {"attachment_type": "type_id", "data": f"conversation-{_CONV_ID}"}


async def _stored() -> FlowMessage:
    row = await FlowMessage.get_one({"id": _FM_ID})
    assert row is not None
    return row


async def test_attachments_the_hub_sends_later_reach_a_row_newer_than_the_hub_clock(initialize_test_db) -> None:
    await fma._process_single_hub_message(_hub_message([]))
    row = await _stored()
    assert not row.attachment
    row.updated_date = _HUB_CLOCK + timedelta(minutes=3)  # a local save after the first sync
    await row.save(notify=False)

    await fma._process_single_hub_message(_hub_message([_TYPE_ID_ATTACHMENT]))

    assert [a.data for a in (await _stored()).attachment] == [_TYPE_ID_ATTACHMENT["data"]]


async def test_a_row_that_already_has_its_attachments_is_left_alone(initialize_test_db) -> None:
    await fma._process_single_hub_message(_hub_message([_TYPE_ID_ATTACHMENT]))
    row = await _stored()
    newer = _HUB_CLOCK + timedelta(minutes=3)
    row.updated_date = newer
    await row.save(notify=False)

    await fma._process_single_hub_message(_hub_message([_TYPE_ID_ATTACHMENT]))

    assert (await _stored()).updated_date == newer


def test_the_drift_predicate_fires_only_when_the_hub_has_attachments_the_row_lacks() -> None:
    from flow_sdk.stream_inbox.hub_clock import hub_adds_attachments

    bare = FlowMessage.model_validate({"id": _FM_ID, "text": "hi"})
    full = FlowMessage.model_validate({"id": _FM_ID, "text": "hi", "attachment": [_TYPE_ID_ATTACHMENT]})
    with_files = _hub_message([_TYPE_ID_ATTACHMENT])

    assert hub_adds_attachments(bare, with_files)
    assert not hub_adds_attachments(full, with_files)
    assert not hub_adds_attachments(bare, _hub_message([]))
    assert not hub_adds_attachments(None, with_files)
