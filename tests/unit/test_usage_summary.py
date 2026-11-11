"""The Daily usage summary answers in a conversation: one per automation on the Automations channel, each
run a message whose text is the headline and whose ``usage.summary.value.json`` is the summary. Its old seed
(a forced-off builtin trigger driving a ``daily-analysis`` flow) is retired from older installs."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.app.automation_message import post_automation_result
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.conversation_channel import AUTOMATIONS
from flow_sdk.builtin.flow_message import AttachmentType, FlowMessageKind
from flow_sdk.builtin.trigger import Trigger
from flow_sdk.schema.data_spec.automation_spec import AutomationRef
from flow_sdk.schema.data_spec.usage_report_spec import UsageSummarySpec
from flow_sdk.storage import get_entity_embedded_storage

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


@pytest.fixture(autouse=True)
def blobs(tmp_path):
    from flow_sdk.request_context import methods as ctx
    from flow_sdk.storage.local_fs_driver import LocalStorageDriver

    ctx.set_default_test_storage_fallback(LocalStorageDriver(str(tmp_path / "blobs")))
    yield
    ctx.set_default_test_storage_fallback(None)


async def test_each_run_is_a_message_in_the_automations_one_conversation():
    rule = await Trigger(name="Daily usage summary").save()
    summary = UsageSummarySpec(period_start="2026-11-08T00:00:00+02:00", period_end="2026-11-09T00:00:00+02:00",
                               total_cost_usd=12.5, session_count=3)
    arrived = AsyncMock()
    with patch("flow_sdk.notifications.notify_message_arrival", arrived):
        automation = AutomationRef(trigger_id=str(rule.id), name=rule.name)
        await post_automation_result(automation, "Sun Nov 8: $12.50 across 3 sessions.", summary)
        await post_automation_result(automation, "Mon Nov 9: no agent sessions.", summary)

    [conv] = await Conversation.get_all({"channel": AUTOMATIONS.name})
    assert (conv.title, conv.channel_source_id) == ("Daily usage summary", str(rule.typeid))
    messages = await conv.messages()
    assert [m.kind for m in messages] == [FlowMessageKind.AUTOMATION_RESULT] * 2
    assert arrived.await_count == 2, "its arrival is the one notification"
    [file] = [a for a in messages[0].attachment or [] if a.attachment_type == AttachmentType.FILE]
    assert file.data.endswith("usage.summary.value.json")
    body = json.loads(open(get_entity_embedded_storage(messages[0].typeid).get_storage_path(file.data)).read())
    assert (body["spec_kind"], body["total_cost_usd"]) == ("usage.summary", 12.5)


async def test_an_older_installs_seeded_trigger_is_retired():
    from flow_sdk.graph_workflow_manager.service_graph_workflows import _retire_daily_analysis

    await Trigger(name="Daily usage summary", uname="builtin_daily_usage_analysis", scope="system").save()
    await _retire_daily_analysis()
    assert await Trigger.get_by_uname("builtin_daily_usage_analysis") is None
