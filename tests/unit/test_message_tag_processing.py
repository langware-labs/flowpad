"""Durable message-tag admission, using the real database and automation executor."""
import asyncio

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.trigger import Trigger
from flow_sdk.builtin import trigger_callbacks
from flow_sdk.schema.data_spec.message_processing_spec import MessageClassificationSettings, MessageProcessing, TagAssignment
from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue
from flow_sdk.schema.data_spec.tag_classification_spec import TagClassification
from flow_sdk.stream_inbox import message_tags as processing
from tests.pytest_plugin import async_context


@pytest.fixture
def explicit_drain(monkeypatch):
    monkeypatch.setattr(processing, "wake", lambda _id: None)


async def rule(tag, callback=None, **kwargs):
    identity = str(mint_uuid())
    if callback:
        trigger_callbacks.register(identity)(callback)
    return await Trigger(name=identity, trigger_type="tag", scope="system",
                         tag_pattern="stream_inbox.*.message.projected", message_tags=[tag],
                         actions=[{"action_type": "callback", "callback_name": identity}] if callback else [],
                         **kwargs).save()


def test_once_claim_survives_cancel_and_readd():
    trigger = Trigger(name="once", message_tags=["billing"])
    state = MessageProcessing()
    tags = processing.apply_delta([], state, add=["billing.refund"], source=TagAssignment(), rules=[trigger])
    assert len(state.queue) == 1
    tags = processing.apply_delta(tags, state, remove=tags, source=TagAssignment(), rules=[trigger])
    assert state.queue[0].status == "cancelled"
    processing.apply_delta(tags, state, add=["billing.refund"], source=TagAssignment(), rules=[trigger])
    assert len(state.queue) == 1


def test_alternative_tag_keeps_queued_and_running_is_not_cancelled():
    trigger = Trigger(name="any", message_tags=["billing", "priority"])
    state = MessageProcessing()
    tags = processing.apply_delta([], state, add=["billing.refund", "priority.today"], source=TagAssignment(), rules=[trigger])
    tags = processing.apply_delta(tags, state, remove=["billing.refund"], source=TagAssignment(), rules=[trigger])
    assert state.queue[0].status == "queued"
    state.queue[0].status = "running"
    processing.apply_delta(tags, state, remove=tags, source=TagAssignment(), rules=[trigger])
    assert state.queue[0].status == "running"


@async_context
async def test_concurrent_additions_claim_once_and_keep_both_tags(explicit_drain):
    tag = f"qa.{mint_uuid()}"
    trigger = await rule(tag)
    message = await FlowMessage(text="incoming").save()
    await asyncio.gather(processing.change_tags(message.id, add=[tag + ".one"]),
                         processing.change_tags(message.id, add=[tag + ".two"]))
    row = await FlowMessage.get_by_id(message.id)
    assert set(row.tags) == {tag + ".one", tag + ".two"}
    assert [entry.trigger_id for entry in row.message_processing.queue] == [trigger.id]


@async_context
async def test_fifo_failure_continues_and_chaining_cannot_cycle(explicit_drain):
    tag = f"qa.{mint_uuid()}"
    seen = []

    async def first(_trigger, _changes):
        seen.append("first")
        correlation = processing.automation_assignment.get()
        await processing.change_tags(correlation[0], add=[tag + ".next"])
        raise ValueError("intentional failure")

    async def second(_trigger, _changes):
        seen.append("second")
        await processing.change_tags(processing.automation_assignment.get()[0], add=[tag + ".start"])

    one = await rule(tag + ".start", first)
    two = await rule(tag + ".next", second)
    message = await FlowMessage(text="incoming").save()
    await processing.change_tags(message.id, add=[tag + ".start"])
    await processing.process_message(message.id)
    await processing.process_message(message.id)
    stored = await FlowMessage.get_by_id(message.id)
    assert seen == ["first", "second"]
    assert [entry.trigger_id for entry in stored.message_processing.queue] == [one.id, two.id]
    assert [entry.status for entry in stored.message_processing.queue] == ["failed", "succeeded"]
    assigned = stored.message_processing.assignments[tag + ".next"]
    assert assigned.source == "automation"
    assert assigned.run_id == stored.message_processing.queue[0].run_id


@async_context
async def test_disable_and_remove_before_execution_never_fire(explicit_drain):
    tag = f"qa.{mint_uuid()}"
    seen = []

    async def action(*_args):
        seen.append(True)

    trigger = await rule(tag, action)
    message = await FlowMessage(text="incoming").save()
    await processing.change_tags(message.id, add=[tag])
    from flow_sdk.builtin.trigger import set_trigger_on

    await set_trigger_on(trigger, False)
    await processing.process_message(message.id)
    stored = await FlowMessage.get_by_id(message.id)
    assert stored.message_processing.queue[0].status == "skipped"
    assert seen == []


@async_context
async def test_classifier_finishing_after_manual_remove_does_not_restore_tag(explicit_drain, monkeypatch):
    tag = f"qa.{mint_uuid()}"
    entered, release = asyncio.Event(), asyncio.Event()

    async def definitions():
        return [{"name": tag, "description": "test"}]

    async def classify(*_args):
        entered.set()
        await release.wait()
        return ReturnedValue.satisfied(value=TagClassification(tag=tag))

    monkeypatch.setattr(processing, "ontology", definitions)
    monkeypatch.setattr(processing, "classify", classify)
    message = await FlowMessage(text="incoming", message_processing=MessageProcessing(classification="pending")).save()
    task = asyncio.create_task(processing.process_message(message.id))
    await entered.wait()
    await processing.change_tags(message.id, remove=[tag])
    release.set()
    await task
    stored = await FlowMessage.get_by_id(message.id)
    assert stored.tags == []
    assert stored.message_processing.classification == "succeeded"


@async_context
async def test_classifier_failure_does_not_block_manual_trigger(explicit_drain, monkeypatch):
    tag = f"qa.{mint_uuid()}"

    async def definitions():
        return [{"name": tag, "description": "test"}]

    async def fail(*_args):
        raise RuntimeError("no model")

    monkeypatch.setattr(processing, "ontology", definitions)
    monkeypatch.setattr(processing, "classify", fail)
    await rule(tag)
    message = await FlowMessage(text="incoming", message_processing=MessageProcessing(classification="pending")).save()
    await processing.process_message(message.id)
    await processing.change_tags(message.id, add=[tag])
    await processing.process_message(message.id)
    stored = await FlowMessage.get_by_id(message.id)
    assert stored.message_processing.classification == "failed"
    assert stored.message_processing.queue[0].status == "succeeded"


@async_context
async def test_two_messages_same_automation_serialize_without_busy_loss(explicit_drain):
    tag = f"qa.{mint_uuid()}"
    seen, entered, release = [], asyncio.Event(), asyncio.Event()

    async def action(*_args):
        seen.append(processing.automation_assignment.get()[0])
        if len(seen) == 1:
            entered.set()
            await release.wait()

    await rule(tag, action)
    first, second = await FlowMessage(text="one").save(), await FlowMessage(text="two").save()
    for message in [first, second]:
        await processing.change_tags(message.id, add=[tag])
    one = asyncio.create_task(processing.process_message(first.id))
    await entered.wait()
    two = asyncio.create_task(processing.process_message(second.id))
    release.set()
    await asyncio.gather(one, two)
    assert seen == [first.id, second.id]
    assert (await FlowMessage.get_by_id(second.id)).message_processing.queue[0].status == "succeeded"


@async_context
async def test_restart_uses_exact_completed_run_and_never_replays_unknown(explicit_drain):
    tag = f"qa.{mint_uuid()}"
    await rule(tag)
    message = await FlowMessage(text="incoming").save()
    await processing.change_tags(message.id, add=[tag])
    await processing.process_message(message.id)

    def interrupted_commit(m, state):
        state.queue[0].status = "running"
        return m.tags

    await processing._mutate(message.id, interrupted_commit)
    await processing.reconcile()
    assert (await FlowMessage.get_by_id(message.id)).message_processing.queue[0].status == "succeeded"
    other = await FlowMessage(text="never started").save()
    await processing.change_tags(other.id, add=[tag])
    await processing._mutate(other.id, interrupted_commit)
    await processing.reconcile()
    await processing.process_message(other.id)
    assert (await FlowMessage.get_by_id(other.id)).message_processing.queue[0].status == "interrupted"


@async_context
async def test_preview_uses_current_tags_without_queue_effect(explicit_drain):
    tag = f"qa.{mint_uuid()}"
    trigger = await rule(tag)
    message = await FlowMessage(text="preview").save()
    assert not (await trigger.decide_on(message_id=message.id)).met
    await processing.change_tags(message.id, add=[tag])
    assert (await trigger.decide_on(message_id=message.id)).met
    assert (await FlowMessage.get_by_id(message.id)).message_processing.queue[0].status == "queued"


@async_context
async def test_user_ontology_not_opted_out_by_stream_inbox_flag(monkeypatch):
    from flow_sdk.builtin.tag import Tag, seed_system_tags
    from flow_sdk.schema.data_spec.message_processing_spec import MessageClassificationSettings

    name = f"--qa--.{mint_uuid()}"
    await Tag(name=name, stream_inbox=False).save()
    await Tag(name=name + ".deprecated", deprecated=True).save()
    await seed_system_tags()
    await Tag(name=f"--qa--.{mint_uuid()}-outside-root").save()
    monkeypatch.setattr(processing, "settings", lambda: MessageClassificationSettings(root=name))
    names = {row["name"] for row in await processing.ontology()}
    assert name in names and name + ".deprecated" not in names
    assert names == {name}, "only the root's subtree is offered"
    assert "message.receipt" not in names
    monkeypatch.setattr(processing, "settings", lambda: MessageClassificationSettings(root=name, include_flow_tags=True))
    assert "message.receipt" in {row["name"] for row in await processing.ontology()}


@async_context
async def test_seeding_new_system_vocabulary_preserves_preexisting_user_tag():
    from flow_sdk.builtin.tag import Tag, seed_system_tags
    from flow_sdk.db import get_db_driver

    # Simulate a user row created before this root became shipped vocabulary.
    await seed_system_tags()
    row = await Tag.get_by_id(Tag.allocate_id({"name": "message.receipt"}))
    await get_db_driver().update_existing_data_fields(row.id, "tag", {"system": False, "title": "My receipt"})
    try:
        await seed_system_tags()
        preserved = await Tag.get_by_id(row.id)
        assert not preserved.system and preserved.title == "My receipt"
    finally:
        await get_db_driver().update_existing_data_fields(row.id, "tag", {"system": True})
        await seed_system_tags()


@async_context
async def test_source_scoped_rule_does_not_enqueue_other_channel(explicit_drain):
    tag = f"qa.{mint_uuid()}"
    await rule(tag, tag_scope=[f"data_source:{mint_uuid()}"])
    message = await FlowMessage(text="hub-native message").save()
    await processing.change_tags(message.id, add=[tag])
    assert (await FlowMessage.get_by_id(message.id)).message_processing.queue == []


@async_context
async def test_arrival_enrollment_excludes_own_but_includes_foreign_agents(monkeypatch):
    from flow_sdk.builtin.agent import Agent
    from flow_sdk.builtin.user import User
    from flow_sdk.schema.data_spec.message_sender_spec import MessageSender

    async def self_ids():
        return {"self"}

    async def no_agent(_id):
        return None

    monkeypatch.setattr(User, "self_ids", self_ids)
    monkeypatch.setattr(Agent, "get_by_id", no_agent)
    foreign = FlowMessage(text="foreign", sender=MessageSender.agent(str(mint_uuid())))
    own = FlowMessage(text="own", sender=MessageSender.user("self"))
    outgoing = FlowMessage(text="outgoing", outbound=True)
    for row in [foreign, own, outgoing]:
        await processing.enroll(row)
    assert foreign.message_processing.classification == "pending"
    assert own.message_processing is None
    assert outgoing.message_processing is None


@async_context
async def test_request_provenance_requires_exact_running_claim(explicit_drain, monkeypatch):
    from starlette.requests import Request
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.request_context import methods
    from flow_sdk.request_context.request_info import RequestInfo

    tag = f"qa.{mint_uuid()}"
    await rule(tag)
    message = await FlowMessage(text="worker subject").save()
    await processing.change_tags(message.id, add=[tag])

    def claim(m, state):
        state.queue[0].status = "running"
        return m.tags

    row = await processing._mutate(message.id, claim)
    entry = row.message_processing.queue[0]
    process = await AgenticProcess(context_data={"automation": {
        "subject_id": message.id, "trigger_id": entry.trigger_id, "run_id": entry.run_id,
    }}).save()
    request = Request({"type": "http", "client": ("127.0.0.1", 12345),
                       "headers": [(b"x-flow-process-id", process.id.encode())]})
    info = RequestInfo()
    info.request = request
    monkeypatch.setattr(methods, "get_current_request_info", lambda: info)
    assert await processing._request_automation(message.id) == (message.id, entry.trigger_id, entry.run_id, entry.tag)
    assert await processing._request_automation(str(mint_uuid())) is None

    def completed(m, state):
        state.queue[0].status = "succeeded"
        return m.tags

    await processing._mutate(message.id, completed)
    assert await processing._request_automation(message.id) is None


@async_context
async def test_unknown_classifier_tag_fails_without_partial_assignment(explicit_drain, monkeypatch):
    async def definitions():
        return [{"name": "known.tag", "description": "known"}]

    async def invalid(*_args):
        return ReturnedValue.satisfied(value=TagClassification(tag="invented.tag"))

    monkeypatch.setattr(processing, "ontology", definitions)
    monkeypatch.setattr(processing, "classify", invalid)
    message = await FlowMessage(text="incoming", message_processing=MessageProcessing(classification="pending")).save()
    await processing.process_message(message.id)
    stored = await FlowMessage.get_by_id(message.id)
    assert stored.tags == []
    assert stored.message_processing.classification == "failed"
    assert "outside" in stored.message_processing.classification_error


@async_context
async def test_removal_cancels_durably_and_stale_message_save_keeps_claim(explicit_drain):
    tag = f"qa.{mint_uuid()}"
    await rule(tag)
    stale = await FlowMessage(text="incoming").save()
    await processing.change_tags(stale.id, add=[tag])
    await processing.change_tags(stale.id, remove=[tag])
    await stale.save()
    await processing.change_tags(stale.id, add=[tag])
    await processing.process_message(stale.id)
    stored = await FlowMessage.get_by_id(stale.id)
    assert stored.tags == [tag]
    assert len(stored.message_processing.queue) == 1
    assert stored.message_processing.queue[0].status == "cancelled"


@async_context
async def test_deleted_rule_is_skipped(explicit_drain):
    tag = f"qa.{mint_uuid()}"
    trigger = await rule(tag)
    message = await FlowMessage(text="incoming").save()
    await processing.change_tags(message.id, add=[tag])
    await trigger.delete()
    await processing.process_message(message.id)
    stored = await FlowMessage.get_by_id(message.id)
    assert stored.message_processing.queue[0].status == "skipped"


async def managed_tag_and_rule():
    from flow_sdk.builtin.tag import Tag

    tag = await Tag(name=f"--qa--.{mint_uuid()}", stream_inbox=True, color="#123456").save()
    trigger = await Trigger(name=str(mint_uuid()), trigger_type="tag", scope="user",
                            tag_pattern="stream_inbox.*.message.projected", message_tags=[tag.name]).save()
    return tag, trigger


@async_context
async def test_rename_preserves_provenance_queue_identity_and_references(explicit_drain):
    from flow_sdk.builtin.tag import Tag, resolve_tag
    from flow_sdk.stream_inbox.tag_management import rename, impact

    tag, trigger = await managed_tag_and_rule()
    message = await FlowMessage(text="rename me").save()
    await processing.change_tags(message.id, add=[tag.name])
    before = await FlowMessage.get_by_id(message.id)
    claim = before.message_processing.queue[0].model_dump()
    assert await impact(tag) == {"messages": 1, "automations": 1}
    renamed = await rename(tag, {"name": tag.name + "-renamed", "color": "#abcdef"})
    name = renamed["tag"]["name"]
    stored = await FlowMessage.get_by_id(message.id)
    assert stored.tags == [name]
    assert stored.message_processing.assignments[name].source == "manual"
    assert stored.message_processing.queue[0].id == claim["id"]
    assert stored.message_processing.queue[0].run_id == claim["run_id"]
    assert stored.message_processing.queue[0].tag == name
    assert (await Trigger.get_by_id(trigger.id)).message_tags == [name]
    assert (await resolve_tag(tag.name)).name == name
    assert (await Tag.get_by_id(tag.id)).deprecated
    await processing.change_tags(message.id, add=[tag.name])
    await processing.process_message(message.id)
    final = await FlowMessage.get_by_id(message.id)
    assert final.tags == [name]
    assert len(final.message_processing.queue) == 1
    assert final.message_processing.queue[0].status == "succeeded"


@async_context
async def test_delete_detaches_without_deleting_messages_and_disables_rule(explicit_drain):
    from flow_sdk.builtin.tag import Tag
    from flow_sdk.stream_inbox.tag_management import delete

    tag, trigger = await managed_tag_and_rule()
    message = await FlowMessage(text="keep this message").save()
    await processing.change_tags(message.id, add=[tag.name])
    assert await delete(tag) == {"messages": 1, "automations": 1}
    assert await Tag.get_by_id(tag.id) is None
    stored = await FlowMessage.get_by_id(message.id)
    assert stored.text == "keep this message" and stored.tags == []
    assert stored.message_processing.queue[0].status == "cancelled"
    assert not (await Trigger.get_by_id(trigger.id)).enabled


@pytest.mark.parametrize("operation", ["rename", "delete", "rename-removed"])
@async_context
async def test_classification_finishes_after_tag_rename_or_delete(explicit_drain, monkeypatch, operation):
    from flow_sdk.stream_inbox import tag_management

    tag, _trigger = await managed_tag_and_rule()
    entered, release = asyncio.Event(), asyncio.Event()

    async def definitions():
        return [{"name": tag.name, "description": "old ontology snapshot"}]

    async def classify(*_args):
        entered.set()
        await release.wait()
        return ReturnedValue.satisfied(value=TagClassification(tag=tag.name))

    monkeypatch.setattr(processing, "ontology", definitions)
    monkeypatch.setattr(processing, "classify", classify)
    message = await FlowMessage(text="in flight", message_processing=MessageProcessing(classification="pending")).save()
    task = asyncio.create_task(processing.process_message(message.id))
    await entered.wait()
    if operation == "rename-removed":
        await processing.change_tags(message.id, remove=[tag.name])
    if operation.startswith("rename"):
        await tag_management.rename(tag, {"name": tag.name + "-next"})
    else:
        await tag_management.delete(tag)
    release.set()
    await task
    stored = await FlowMessage.get_by_id(message.id)
    assert stored.tags == ([tag.name + "-next"] if operation == "rename" else [])
    assert stored.message_processing.classification == "succeeded"
    if operation == "rename-removed":
        assert tag.name + "-next" in stored.message_processing.suppressed_tags


def test_local_cli_process_header_never_leaves_loopback(monkeypatch):
    import json
    import requests
    from flow_sdk.cli.commands._common import local_request

    identity = str(mint_uuid())
    monkeypatch.setenv("FLOWPAD_EXECUTION_SCOPE", json.dumps([{"type": "agentic_process", "id": identity}]))
    sent = []
    monkeypatch.setattr(requests, "request", lambda _method, _url, **kwargs: sent.append(kwargs))
    local_request("POST", "http://127.0.0.1:9999/api/v1/graph")
    local_request("POST", "https://example.invalid/api")
    assert sent[0]["headers"]["X-Flow-Process-Id"] == identity
    assert "X-Flow-Process-Id" not in sent[1].get("headers", {})


@async_context
async def test_message_event_preserves_provider_and_source_scope(explicit_drain):
    from flow_sdk.builtin.source_item import SourceItem
    from flow_sdk.fs_store.origin.cloud_origin import CloudOriginLocal

    source_id = str(mint_uuid())
    item = await SourceItem(data_source_id=source_id, provider="gmail", kind="content.message.email",
                            external_id=str(mint_uuid()), name="message", body="body").save()
    message = await FlowMessage(text="", source_item_id=item.id,
                                origin_local=CloudOriginLocal(data_source_id=source_id, source_item_id=item.id)).save()
    event = await processing.message_event(message)
    assert event.tag == "stream_inbox.gmail.message.projected"
    assert event.target == f"source_item:{item.id}"
    assert event.ctx.scope == [f"data_source:{source_id}"]


@async_context
async def test_catchup_then_live_create_classifies_once_and_duplicate_keeps_claim(explicit_drain, monkeypatch):
    from flow_sdk.app.actions.materialize_flow_message import materialize_flow_message
    from flow_sdk.builtin.tag import Tag

    tag = await Tag(name=f"--qa--.{mint_uuid()}").save()
    trigger = await rule(tag.name)
    calls = []

    async def classify(*_args):
        calls.append(True)
        return ReturnedValue.satisfied(value=TagClassification(tag=tag.name))

    monkeypatch.setattr(processing, "classify", classify)
    monkeypatch.setattr(processing, "settings", lambda: MessageClassificationSettings(root=tag.name))
    conversation_id = str(mint_uuid())
    payload = {"id": str(mint_uuid()), "text": "An incoming message", "sender_id": str(mint_uuid())}

    async def materialize(*, live=False):
        return await materialize_flow_message(payload, conversation_id, someone_typeid=None,
                                              remote=True, notify=False, emit_live_create=live,
                                              classify_message=live)

    historical = await materialize()
    assert historical.message_processing is None
    assert (await materialize()).message_processing is None
    assert calls == []
    live = await materialize(live=True)
    assert live.message_processing.classification == "pending"
    await materialize(live=True)
    await processing.process_message(live.id)
    completed = await FlowMessage.get_by_id(live.id)
    mine = lambda m: [e.model_dump() for e in m.message_processing.queue if e.trigger_id == str(trigger.id)]
    claim, = mine(completed)
    assert completed.message_processing.classification == "succeeded"
    assert claim["status"] == "succeeded"
    assert len(calls) == 1
    await materialize(live=True)
    await processing.process_message(live.id)
    duplicate = await FlowMessage.get_by_id(live.id)
    assert mine(duplicate) == [claim]
    assert len(calls) == 1
    assert (await Trigger.get_by_id(trigger.id)).counter == 1


@async_context
async def test_classifier_is_the_first_queue_entry_and_its_switch_decides(explicit_drain, monkeypatch):
    from flow_sdk.builtin.trigger import set_trigger_on
    from flow_sdk.server.builtin_triggers import set_service_triggers

    tag = f"qa.{mint_uuid()}"
    answers = iter([tag, ""])  # the first message lands on the tag; the second fits none

    async def definitions():
        return [{"name": tag, "description": "test"}]

    async def classify(*_args):
        return ReturnedValue.satisfied(value=TagClassification(tag=next(answers)))

    monkeypatch.setattr(processing, "ontology", definitions)
    monkeypatch.setattr(processing, "classify", classify)
    from flow_sdk.builtin.tag import Tag

    await Tag(name=tag, stream_inbox=True).save()
    await set_service_triggers()
    classifier = await processing.classifier()
    assert classifier.switchable and classifier.is_builtin
    follower = await rule(tag)

    async def arrive():
        message = await FlowMessage(text="incoming", message_processing=MessageProcessing(
            classification="pending", queue=processing._classifier_entry(classifier))).save()
        await processing.process_message(message.id)
        return await FlowMessage.get_by_id(message.id)

    tagged = await arrive()
    assert tagged.tags == [tag]
    assert [(e.trigger_id, e.status) for e in tagged.message_processing.queue] == [
        (classifier.id, "succeeded"), (follower.id, "succeeded")]

    untagged = await arrive()  # "none of these": classified, no tag, nothing queued behind it
    assert untagged.tags == [] and untagged.message_processing.classification == "succeeded"
    assert [e.trigger_id for e in untagged.message_processing.queue] == [classifier.id]

    await set_trigger_on(classifier, False)
    await set_service_triggers()  # a restart re-seeds the rule: the person's switch stays off
    assert not await processing.classifier_on()
    answers = iter([tag])
    skipped = await arrive()
    assert skipped.tags == [] and skipped.message_processing.queue[0].status == "skipped"
    await processing.classify_now(skipped.id)  # a person asks: it runs although the switch is off
    await processing.process_message(skipped.id)
    asked = await FlowMessage.get_by_id(skipped.id)
    assert asked.tags == [tag] and asked.message_processing.queue[0].status == "succeeded"
    await set_trigger_on(classifier, True)


@async_context
async def test_run_again_requeues_only_a_failed_entry_as_a_new_run(explicit_drain):
    tag = f"qa.{mint_uuid()}"
    calls = []

    async def flaky(_trigger, _changes):
        calls.append(processing.automation_assignment.get()[2])
        if len(calls) == 1:
            raise ValueError("first time fails")

    await rule(tag, flaky)
    message = await FlowMessage(text="incoming").save()
    await processing.change_tags(message.id, add=[tag])
    await processing.process_message(message.id)
    entry = (await FlowMessage.get_by_id(message.id)).message_processing.queue[0]
    assert entry.status == "failed"
    assert await processing.run_again(message.id, entry.id) is not None
    await processing.process_message(message.id)
    again = (await FlowMessage.get_by_id(message.id)).message_processing.queue[0]
    assert again.status == "succeeded" and again.id == entry.id and len(set(calls)) == 2
    assert await processing.run_again(message.id, entry.id) is None  # nothing to run again
