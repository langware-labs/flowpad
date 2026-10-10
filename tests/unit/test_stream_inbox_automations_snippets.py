"""``docs/snippets/stream-inbox-automations.md``: every Python fence, run in order as one session.

The Decision API is doubled at the hub's seams (``tests/utils/decision_double.py``), the worker by
the mock driver; the projection, the trigger fire path and the wizard runner are real. The page's
names are seeded here first: a source called "Work mail", an agent called "Billing helper", one
projected message from Dana — exactly what the fences look up.
"""

from __future__ import annotations

import uuid

import pytest

from tests.utils.snippets import run_page

pytestmark = [pytest.mark.timeout(30), pytest.mark.usefixtures("tmp_records_root", "home")]  # do not increase timeout without approval


async def _seed():
    from flow_sdk.builtin.agent import Agent
    from flow_sdk.builtin.data_source import DataSource
    from flow_sdk.builtin.source_item import SourceItem
    from flow_sdk.stream_inbox.projection import project_source_item

    for name in ("Work mail",):
        for other in await DataSource.get_all({"name": name}):
            await other.delete()
    for other in await Agent.get_all({"name": "Billing helper"}):
        await other.delete()
    source = DataSource(provider="agent", channel="gmail", name="Work mail", account_key="me@work.test",
                        config={"connector": "gmail", "harness": "claude"})
    await source.save()
    agent = Agent(name="Billing helper", system_prompt="You handle refunds.")
    await agent.save()
    item = SourceItem(
        id=str(uuid.uuid4()), data_source_id=source.id, provider="agent", kind="content.message.email",
        external_id=f"<{uuid.uuid4().hex[:8]}@x>", name="Charged twice for October",
        body="I see two charges of $49 on my card for October. Please look into it and refund one of them.",
        author_external_id="dana@customer.test", author_display="Dana Levi", occurred_at="2026-10-10T10:41:00+00:00",
    )
    await item.save(notify=False)
    await project_source_item(item, source=source, notify=False, announce=False)
    return item


async def test_the_page_runs_in_order_as_one_session(initialize_test_db, decision_double, mock_driver, tmp_path, monkeypatch):
    driver = mock_driver(lambda turn: "Drafted the reply in the conversation.")
    monkeypatch.chdir(tmp_path)
    item = await _seed()
    ns = await run_page("stream-inbox-automations.md", {"item": item}, until="## 9.")

    rule = ns["rule"]
    assert rule.tag_pattern == "stream_inbox.*.message.projected" and rule.gate["input"] == "MESSAGE"
    assert ns["verdict"].met and ns["verdict"].confidence == 0.9
    assert ns["state"].sender.startswith("Dana Levi") and ns["state"].message_id
    run = ns["run"]
    assert run.decision["caught"] and run.subject_id == ns["fm"].id and run.agentic_process_id
    assert run.wizard["exit_code"] == 0
    assert driver.received_prompts, "the then wizard ran the agent"
    process = ns["process"]
    assert process.context_data["automation"]["trigger_id"] == rule.id
    assert ns["summary"].started_last_hour >= 1
    assert decision_double["invoked"], "the gate was asked through the hub"
