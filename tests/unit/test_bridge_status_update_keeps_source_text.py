"""A hub status update on a source message must not blank it in every open view.

A message projected from a data source (a help-desk ticket's lines) stores no text of its own: it is joined
from its SourceItem when read. When the hub confirms a send (``delivery_status: sent``), the bridge patches the
one field and announces the row. Announcing the stored row shipped ``text: ""``, so the staff member's reply
showed empty until the next poll.
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.cloud_client.hub_bridge import HubWsBridge
from flow_sdk.stream_inbox.projection import project_source_item

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


class _NoHub:
    def send(self, *_a, **_kw):
        pass


@pytest.mark.asyncio
async def test_the_announced_row_carries_the_text_of_a_source_message(monkeypatch, tmp_path):
    monkeypatch.setattr("flow_sdk.fs_store.record_paths.get_default_records_data_root", lambda: tmp_path)
    src = DataSource(
        provider="agent", channel="gmail", name=f"Desk {uuid.uuid4().hex[:8]}",
        account_key=f"acct-{uuid.uuid4().hex[:8]}", config={"connector": "gmail", "harness": "claude"},
    )
    await src.save()
    item = SourceItem(
        id=str(uuid.uuid4()), data_source_id=src.id, provider="agent", kind="content.message.email",
        external_id=f"<{uuid.uuid4().hex[:8]}@x>", name="Re: invoices", body="Open Projects and add Billing.",
        author_external_id="noa@acme.test", thread_key=f"t-{uuid.uuid4().hex[:8]}",
    )
    await item.save(notify=False)
    fm_id, _thread = await project_source_item(item, source=src, notify=False, announce=False)
    fm = await FlowMessage.get_by_id(fm_id)
    assert fm.text == "Open Projects and add Billing."

    announced = []
    real = FlowMessage.add_entity_op_notification

    async def spy(self, change, *a, **kw):
        announced.append(change.data.text)
        return await real(self, change, *a, **kw)

    monkeypatch.setattr(FlowMessage, "add_entity_op_notification", spy)

    await HubWsBridge(_NoHub())._handle_flow_message_op("update", fm_id, {"delivery_status": "sent"}, fm.conversation_id)

    assert announced == ["Open Projects and add Billing."]
