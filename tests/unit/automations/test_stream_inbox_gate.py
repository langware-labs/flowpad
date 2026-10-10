"""The gate in the TAG fire path: after every cheap check, before the counter.

Real projection (a message placed in a conversation), real fire path, real wizard runner; the
Decision API doubled, the worker doubled. Each test is one corner: declined, caught, unavailable,
own message, a test run, the storm guard ahead of the gate.
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.automations.run_once import run_once
from flow_sdk.builtin import tag_triggers
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.builtin.trigger import Trigger
from flow_sdk.stream_inbox.projection import project_source_item
from flow_sdk.stream_inbox.stream_inbox_on_tag import projected_envelope
from flow_sdk.tags import emit_tag
from flow_sdk.tags.bus import drain
from tests.unit.automations._helpers import history

pytestmark = [pytest.mark.timeout(10), pytest.mark.usefixtures("tmp_records_root", "home")]  # do not increase timeout without approval


async def _source() -> DataSource:
    source = DataSource(provider="agent", channel="gmail", name=f"mail {uuid.uuid4().hex[:6]}",
                        account_key=f"{uuid.uuid4().hex[:6]}@x.test", config={"connector": "gmail", "harness": "claude"})
    await source.save()
    return source


async def _message(source: DataSource, body: str, *, own: bool = False) -> tuple[SourceItem, FlowMessage]:
    item = SourceItem(
        id=str(uuid.uuid4()), data_source_id=source.id, provider="agent", kind="content.message.email",
        external_id=f"<{uuid.uuid4().hex[:8]}@x>", name="Charged twice for October", body=body,
        author_external_id=source.account_key if own else "dana@customer.test",
        occurred_at="2026-10-10T10:41:00+00:00",
    )
    await item.save(notify=False)
    fm_id, _ = await project_source_item(item, source=source, notify=False, announce=False)
    fm = await FlowMessage.get_by_id(fm_id)
    if own:
        # The test DB has no local user for the projection to attribute our address to; type it the
        # way the projection would (`MessageSender.user`), which is what the subject reads.
        from flow_sdk.schema.data_spec.message_sender_spec import MessageSender

        fm.sender = MessageSender.user("11111111-1111-4111-8111-111111111111")
        await fm.save(notify=False)
        fm = await FlowMessage.get_by_id(fm_id)
    return item, fm


async def _agent() -> Agent:
    for other in await Agent.get_all({"name": "billing-helper"}):
        await other.delete()
    agent = Agent(name="billing-helper", system_prompt="You handle refunds.")
    await agent.save()
    return agent


async def _rule(source: DataSource, agent: Agent, **kw) -> Trigger:
    rule = await Trigger.on_message(catch="asks for a refund or disputes a charge", sources=[source], agent=agent,
                                    prompt="Draft the reply.", **kw)
    return rule


def _arrives(item: SourceItem, source: DataSource) -> None:
    """The real announcement's envelope (``projected_envelope``), so the gate is proven against it."""
    parts = projected_envelope("agent", str(item.id), str(source.id))
    emit_tag(parts["tag"], parts["target"], parts["data"], ctx={"scope": parts["scope"]})


@pytest.fixture
def decided():
    """Every `trigger.decided` envelope the fire path put on the bus."""
    from flow_sdk.tags.bus import event_bus

    seen: list = []
    off = event_bus.on("trigger.decided", lambda e: seen.append(e))
    yield seen
    off()


async def test_a_no_costs_one_decision_and_spends_nothing(initialize_test_db, decision_double, decided, mock_driver):
    mock_driver(lambda turn: "never")
    decision_double["answers"]["match"] = 0.12
    source, agent = await _source(), await _agent()
    rule = await _rule(source, agent, enabled=True)
    item, fm = await _message(source, "Attached is the invoice for September.")
    try:
        _arrives(item, source)
        await drain()
    finally:
        tag_triggers.unregister_tag_trigger(rule.id)
    row = await Trigger.get_by_id(rule.id)
    assert row.counter == 0, "a declined fire never counts"
    (declined,) = history(rule)
    assert declined["hook_event"] == "tag_declined" and declined["reason_code"] == "decision_no"
    assert declined["decision"]["caught"] is False and declined["decision"]["confidence"] == 0.12
    assert declined["decision"]["reason"] == "match was 0.12, needed yes ≥ 0.85"
    assert declined["subject_id"] == fm.id
    assert [e.data["outcome"] for e in decided] == ["no"]
    assert len(decision_double["invoked"]) == 1


async def test_caught_runs_the_wizard_with_the_message_as_the_agents_input(initialize_test_db, decision_double, decided, mock_driver):
    seen: dict = {}

    def behavior(turn):
        seen["files"] = turn.listdir(turn.input_dir)
        seen["body"] = "".join(turn.read(turn.input_dir / f) for f in seen["files"])
        return "Drafted."

    driver = mock_driver(behavior)
    source, agent = await _source(), await _agent()
    rule = await _rule(source, agent)
    item, fm = await _message(source, "I see two charges of $49 on my card, please refund one.")
    try:
        _arrives(item, source)
        await drain()
    finally:
        tag_triggers.unregister_tag_trigger(rule.id)
    assert (await Trigger.get_by_id(rule.id)).counter == 1
    start, done = history(rule)
    assert start["hook_event"] == "tag_fire" and start["decision"]["caught"] and start["subject_id"] == fm.id
    assert done["hook_event"] == "tag_fire_done" and done["error"] is None
    assert done["wizard"]["exit_code"] == 0 and "handle" in done["wizard"]["steps"]
    assert driver.received_prompts and "two charges" in seen["body"], "the state was the agent's input"
    process = await AgenticProcess.get_by_id(done["agentic_process_id"])
    assert process.target_typeid_str == f"conversation-{fm.conversation_id}"
    assert f"flow_message-{fm.id}" in [str(t) for t in process.shared_context_entities]
    automation = process.context_data["automation"]
    assert automation["trigger_id"] == rule.id and automation["run_id"] == start["id"]
    assert automation["reason"] == "asks for a refund or disputes a charge" and automation["confidence"] == 0.9
    assert [e.data["outcome"] for e in decided] == ["caught"]


async def test_unavailable_is_recorded_and_the_rule_waits(initialize_test_db, decision_double, decided, mock_driver):
    mock_driver(lambda turn: "never")
    decision_double["status"] = 429
    source, agent = await _source(), await _agent()
    rule = await _rule(source, agent)
    item, _ = await _message(source, "Refund please.")
    try:
        _arrives(item, source)
        await drain()
    finally:
        tag_triggers.unregister_tag_trigger(rule.id)
    assert (await Trigger.get_by_id(rule.id)).counter == 0
    (row,) = history(rule)
    assert row["reason_code"] == "decision_unavailable" and row["decision"]["unavailable"] == "rate_limited"
    assert [e.data["outcome"] for e in decided] == ["unavailable"]


async def test_our_own_message_is_never_asked_about(initialize_test_db, decision_double, mock_driver):
    mock_driver(lambda turn: "never")
    source, agent = await _source(), await _agent()
    rule = await _rule(source, agent)
    item, _ = await _message(source, "Here is your refund.", own=True)
    try:
        _arrives(item, source)
        await drain()
    finally:
        tag_triggers.unregister_tag_trigger(rule.id)
    (row,) = history(rule)
    assert row["reason_code"] == "decision_no" and row["decision"]["reason"] == "own message"
    assert decision_double["invoked"] == [], "no decision was spent on it"


async def test_the_storm_guard_sits_before_the_gate(initialize_test_db, decision_double, mock_driver):
    mock_driver(lambda turn: "ok")
    source, agent = await _source(), await _agent()
    rule = await _rule(source, agent)
    rule.max_fires_per_minute = 1
    await rule.update()
    first, _ = await _message(source, "Refund one")
    second, _ = await _message(source, "Refund two")
    try:
        _arrives(first, source)
        await drain()
        _arrives(second, source)
        await drain()
    finally:
        tag_triggers.unregister_tag_trigger(rule.id)
    assert len(decision_double["invoked"]) == 1, "the second message was dropped before any question was asked"
    assert [r["hook_event"] for r in history(rule)][-1] == "storm_suppressed"


async def test_run_once_on_a_message_is_a_test_run(initialize_test_db, decision_double, mock_driver):
    mock_driver(lambda turn: "Drafted.")
    source, agent = await _source(), await _agent()
    rule = await _rule(source, agent, enabled=False)
    _, fm = await _message(source, "Please refund the duplicate charge.")
    try:
        started = await run_once(rule, message_id=fm.id)
        await drain()
        from flow_sdk.automations import run_once as module

        for task in list(module._inflight):
            await task
        await drain()
    finally:
        tag_triggers.unregister_tag_trigger(rule.id)
    assert started.event_id
    assert (await Trigger.get_by_id(rule.id)).counter == 0
    rows = history(rule)
    assert [r["hook_event"] for r in rows] == ["tag_fire", "tag_fire_done"] and all(r["is_test"] for r in rows)
    assert rows[0]["decision"]["caught"] and rows[0]["subject_id"] == fm.id and rows[1]["agentic_process_id"]


async def test_decide_on_and_the_try_list_record_nothing(initialize_test_db, decision_double, mock_driver):
    mock_driver(lambda turn: "never")
    source, agent = await _source(), await _agent()
    rule = await _rule(source, agent)
    _, fm = await _message(source, "Can I switch to the yearly plan?")
    decision_double["answers"]["match"] = 0.61
    try:
        verdict = await rule.decide_on(text="I was billed twice, reverse it")
        assert not verdict.met and verdict.confidence == 0.61
        decision_double["answers"]["match"] = 0.95
        verdict = await rule.decide_on(message_id=fm.id)
        assert verdict.met
    finally:
        tag_triggers.unregister_tag_trigger(rule.id)
    assert history(rule) == [], "asking is not firing"
