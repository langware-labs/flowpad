"""An app message carries a nano-app and the value it opens on; its header is text written when it is posted."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.app.automation_message import post_app_message
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.conversation_channel import AUTOMATIONS
from flow_sdk.builtin.flow_message import APP_FILE, AttachmentType
from flow_sdk.builtin.trigger import Trigger
from flow_sdk.schema.data_spec.automation_spec import AutomationRef
from flow_sdk.schema.data_spec.message_app_spec import MessageAppSpec
from flow_sdk.schema.data_spec.usage_report_spec import UsageSummarySpec

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

APP = ('<script type="application/json" id="nano-app">{"name": "usage", "title": "Usage"}</script>'
       '<template data-slot="header">{{sessions}} sessions</template><main data-slot="page">x</main>')


@pytest.fixture(autouse=True)
def blobs(tmp_path):
    from flow_sdk.request_context import methods as ctx
    from flow_sdk.storage.local_fs_driver import LocalStorageDriver

    ctx.set_default_test_storage_fallback(LocalStorageDriver(str(tmp_path / "blobs")))
    yield
    ctx.set_default_test_storage_fallback(None)


@pytest.mark.long  # 0.99s -- one real message send
async def test_an_app_message_carries_the_app_its_value_and_its_header_as_text():
    rule = await Trigger(name="Usage").save()
    value = UsageSummarySpec(period_start="2026-11-08T00:00:00+02:00", period_end="2026-11-09T00:00:00+02:00",
                             total_cost_usd=12.5, session_count=3)
    with patch("flow_sdk.notifications.notify_message_arrival", AsyncMock()) as arrived:
        await post_app_message(AutomationRef(trigger_id=str(rule.id), name=rule.name), APP, value,
                               status="needs_review", data={"sessions": 3})

    [conv] = await Conversation.get_all({"channel": AUTOMATIONS.name, "channel_source_id": str(rule.typeid)})
    [message] = await conv.messages()
    assert message.app == MessageAppSpec(status="needs_review", header="3 sessions")
    assert message.text == "3 sessions", "the row and the arrival notice read the header"
    files = [a.data.rsplit("/", 1)[-1] for a in message.attachment or [] if a.attachment_type == AttachmentType.FILE]
    assert files == [APP_FILE, "usage.summary.value.json"]
    assert arrived.await_count == 1


async def test_a_page_that_is_not_a_nano_app_is_not_posted():
    rule = await Trigger(name="Plain").save()
    with pytest.raises(ValueError, match="nano-app"):
        await post_app_message(AutomationRef(trigger_id=str(rule.id), name=rule.name), "<main>hi</main>", None)


@pytest.mark.long  # ~1s -- one real message send
async def test_the_app_reads_its_value_and_keeps_its_decisions_on_the_message_its_key_names():
    from flow_sdk.builtin.flow_message import app_message_at
    from flow_sdk.core.navigate import with_state_key
    from flow_sdk.server import page_state
    from flow_sdk.storage import get_entity_embedded_storage

    app = APP.replace('"title": "Usage"', '"title": "Usage", "input": "usage.summary"')
    rule = await Trigger(name="Keyed").save()
    value = UsageSummarySpec(period_start="2026-11-08T00:00:00+02:00", period_end="2026-11-09T00:00:00+02:00",
                             total_cost_usd=12.5, session_count=3)
    with patch("flow_sdk.notifications.notify_message_arrival", AsyncMock()):
        await post_app_message(AutomationRef(trigger_id=str(rule.id), name=rule.name), app, value)
    [conv] = await Conversation.get_all({"channel": AUTOMATIONS.name, "channel_source_id": str(rule.typeid)})
    [message] = await conv.messages()

    data = message.app_data()
    assert data.input["spec_kind"] == "usage.summary" and data.input["session_count"] == 3
    assert data.saved is None
    message.save_app_data({"rejected": ["a"]})
    assert message.app_data().saved == {"rejected": ["a"]}

    # Whoever shows the app's own file names the message in the key -- and only for that file.
    page = get_entity_embedded_storage(message.typeid).get_storage_path(f"data/{APP_FILE}")
    assert app_message_at(page) == str(message.typeid)
    assert app_message_at(page.replace(APP_FILE, "usage.summary.value.json")) is None
    shown = with_state_key({"kind": "vfs", "path": page}, None)
    assert page_state.lookup(shown["state_key"]).context == {"message": str(message.typeid)}
