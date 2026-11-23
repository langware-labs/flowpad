"""Message-owned classification and FIFO automation admission.

The bus wakes consumers; the message row is the durable truth. A short writer
transaction owns tag deltas and once claims, never model or automation work.
"""
from __future__ import annotations

import asyncio
import inspect
import logging
from contextvars import ContextVar
from functools import partial
from typing import Callable

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.schema.data_spec.trigger_types import MESSAGE_CLASSIFIER as CLASSIFIER
from flow_sdk.schema.data_spec.message_processing_spec import (
    MessageAutomationEntry, MessageClassificationSettings, MessageProcessing, TagAssignment,
)
from flow_sdk.stream_inbox._locks import new_registry, single_flight
from flow_sdk.tags.grammar import tag_is_within, to_tags

logger = logging.getLogger(__name__)
#: The claim a running rule holds: (message id, trigger id, run id, the tag that queued it).
automation_assignment: ContextVar[tuple[str, str, str, str] | None] = ContextVar("message_tag_automation", default=None)
_drains = new_registry()
_tasks: set[asyncio.Task] = set()
_CONFIG = "message_classification"

async def enroll(message) -> None:
    """Stamp pending BEFORE the new incoming row is saved, never on a historical read."""
    from flow_sdk.builtin.user import User
    from flow_sdk.schema.data_spec.message_sender_spec import SenderKind

    if message.outbound or message.remote_worker_session_id:
        return
    sender = message.sender
    self_ids = await User.self_ids()
    if sender is not None and sender.kind is SenderKind.USER and sender.id in self_ids:
        return
    if sender is not None and sender.kind is SenderKind.AGENT:
        from flow_sdk.builtin.agent import Agent

        agent = await Agent.get_by_id(sender.id)
        if agent is not None and (not agent.remote or str(agent.created_by or "").removeprefix("user-") in self_ids):
            return
    message.message_processing = MessageProcessing(classification="pending", queue=_classifier_entry(await classifier()))


async def enroll_live_existing(message_id: str):
    """A live CREATE may arrive after catch-up saved its row. Claim it once.

    Only the explicit live-arrival writer calls this; historical reads/imports
    never opt an existing row into classification. Compare under the writer lock
    so a repeated CREATE cannot reset classification, manual tags or once claims.
    """
    from flow_sdk.builtin.flow_message import FlowMessage
    from flow_sdk.db import get_db_driver

    db = get_db_driver()
    async with db.write_transaction():
        message = await FlowMessage.get_by_id(message_id)
        if message is None or message.message_processing is not None:
            return message
        await enroll(message)
        if message.message_processing is not None:
            await db.update_existing_data_fields(message_id, FlowMessage.get_type(), {
                "message_processing": message.message_processing.model_dump(mode="json"),
            })

            await db.after_commit(partial(_publish, message_id))
        return message


async def classifier():
    """The classifier's own automation row; None before the first boot seeded it."""
    from flow_sdk.builtin.trigger import Trigger

    return await Trigger.get_by_uname(CLASSIFIER)


async def classifier_on() -> bool:
    rule = await classifier()
    return rule is None or bool(rule.enabled)


def _classifier_entry(rule) -> list[MessageAutomationEntry]:
    """The classifier's place in a message's queue: first, with no tag of its own."""
    if rule is None:
        return []
    return [MessageAutomationEntry(id=str(mint_uuid()), trigger_id=str(rule.id), automation_name=rule.name or "", tag="")]


def _mark_classifier(state: MessageProcessing) -> None:
    """The classifier's queue entry says what ``classification`` says — one fact, shown in the queue.
    Called by the one writer (``_mutate``), so no change to ``classification`` can leave it behind."""
    entry = next((e for e in state.queue if not e.tag), None)
    if entry is not None:
        entry.status = "queued" if state.classification == "pending" else state.classification
        entry.error = state.classification_error


def settings() -> MessageClassificationSettings:
    from flow_sdk.cli.app_config import get_config

    stored = get_config(_CONFIG, {})
    return MessageClassificationSettings.model_validate(
        {k: v for k, v in stored.items() if k in MessageClassificationSettings.model_fields})


def save_settings(value: dict) -> MessageClassificationSettings:
    from flow_sdk.cli.app_config import set_config

    parsed = MessageClassificationSettings.model_validate(value)
    set_config(_CONFIG, parsed.model_dump(mode="json"))
    return parsed


async def ontology() -> list[dict[str, str]]:
    """The classifier's options: every tag within the configured root (plus Flowpad's own
    message tags when opted in), with what each one means."""
    from flow_sdk.tags.classify import options

    current = settings()
    meanings = await options(current.root, include_flow_tags=current.include_flow_tags)
    return [{"name": name, "description": meaning} for name, meaning in meanings.items()]


def matching_tag(rule, tags: list[str]) -> str | None:
    return next((tag for tag in tags if any(tag_is_within(tag, root) for root in rule.message_tags)), None)


async def message_event(message):
    from flow_sdk.stream_inbox.stream_inbox_on_tag import conversation_message_envelope, projected_envelope
    from flow_sdk.tags import make_tag_event

    if message.source_item_id:
        from flow_sdk.builtin.source_item import SourceItem

        item = await SourceItem.get_by_id(str(message.source_item_id))
        envelope = projected_envelope(item.provider if item is not None else "unknown",
                                      str(message.source_item_id),
                                      str(getattr(message.origin_local, "data_source_id", "") or ""))
    else:
        envelope = conversation_message_envelope(str(message.id), str(message.conversation_id or ""))
    return make_tag_event(envelope["tag"], envelope["target"], envelope["data"], ctx={"scope": envelope["scope"]})


async def scoped_rules(message, rules):
    from flow_sdk.tags.bus import explain_subscription_match

    event = await message_event(message)
    return [rule for rule in rules if all(explain_subscription_match(
        rule.tag_pattern, event.tag, event.target, target_filter=rule.tag_target,
        scope_filter=rule.tag_scope, scope=event.ctx.scope).values())]


async def _rules():
    from flow_sdk.builtin.trigger import Trigger
    from flow_sdk.builtin.trigger_arming import runs_here
    from flow_sdk.schema.data_spec.trigger_types import TriggerType

    rows = await Trigger.list_by_type(TriggerType.TAG)
    eligible = [r for r in rows if r.message_tags and r.enabled and not r.ended_at and await runs_here(r)]
    return sorted(eligible,
                  key=lambda r: (str(r.created_date or ""), str(r.id)))


def apply_delta(tags: list[str], state: MessageProcessing, *, add=(), remove=(), replace=None,
                source: TagAssignment, rules=(), start_automations=True) -> list[str]:
    """Pure state transition: a once claim is the entry, including cancelled entries.
    ``start_automations=False`` changes the tags without queueing anything (a person applied a classification)."""
    before = list(tags)
    desired = to_tags(replace) if replace is not None else list(tags)
    desired = list(dict.fromkeys([*desired, *to_tags(add)]))
    removed = set(to_tags(remove)) | (set(before) - set(desired))
    desired = [t for t in desired if t not in removed]
    if source.source == "manual":
        state.suppressed_tags = sorted((set(state.suppressed_tags) | removed) - set(desired))
    elif source.source == "classification":
        desired = [t for t in desired if t in before or t not in state.suppressed_tags]
    added = [t for t in desired if t not in before]
    state.assignments = {t: assignment for t, assignment in state.assignments.items() if t in desired}
    for tag in added:
        state.assignments[tag] = source.model_copy()
    by_id = {str(rule.id): rule for rule in rules}
    for entry in state.queue:
        if entry.status == "queued":
            rule = by_id.get(entry.trigger_id)
            if rule is not None and not matching_tag(rule, desired):
                entry.status, entry.error = "cancelled", "The message no longer carries a qualifying tag."
    spent = {entry.trigger_id for entry in state.queue}
    for rule in rules if start_automations else ():
        tag = matching_tag(rule, added)
        if tag and str(rule.id) not in spent:
            identity = str(mint_uuid())
            state.queue.append(MessageAutomationEntry(id=identity, run_id=identity,
                               trigger_id=str(rule.id), automation_name=rule.name or "", tag=tag))
            spent.add(str(rule.id))
    return desired


async def _publish(message_id: str, *, wake_worker=False) -> None:
    from flow_sdk.builtin.flow_message import FlowMessage

    # Re-read at publication, so an intervening writer never gets an older frame.
    fresh = await FlowMessage.get_by_id(message_id)
    if fresh is not None:
        await fresh.store()
        await fresh.notify_updated()
    if wake_worker:
        wake(message_id)


async def _mutate(message_id: str, change: Callable, *, wake_worker=False):
    from flow_sdk.builtin.flow_message import FlowMessage
    from flow_sdk.db import get_db_driver

    db = get_db_driver()
    async with db.write_transaction():
        message = await FlowMessage.get_by_id(message_id)
        if message is None:
            return None
        before = message.model_dump(mode="json", include={"tags", "message_processing"})
        state = message.message_processing.model_copy(deep=True) if message.message_processing else MessageProcessing()
        tags = change(message, state)
        if inspect.isawaitable(tags):
            tags = await tags
        _mark_classifier(state)
        values = {"tags": tags, "message_processing": state.model_dump(mode="json")}
        if values != before:
            await db.update_existing_data_fields(message_id, FlowMessage.get_type(), values)

            await db.after_commit(partial(_publish, message_id, wake_worker=wake_worker))
        message.tags, message.message_processing = tags, state
        return message


async def change_tags(message_id: str, *, add=(), remove=(), replace=None,
                      source: TagAssignment | None = None):
    current = automation_assignment.get() or await _request_automation(message_id)
    source = source or (TagAssignment(source="automation", trigger_id=current[1], run_id=current[2])
                        if current and current[0] == message_id else TagAssignment())
    async def change(m, s):
        from flow_sdk.builtin.tag import resolve_tag

        async def canonical(names):
            result = []
            for name in to_tags(names):
                definition = await resolve_tag(name)
                result.append(definition.name if definition is not None else name)
            return result

        rules = await _rules()
        additions = await canonical(add)
        removals = list(dict.fromkeys([*to_tags(remove), *await canonical(remove)]))
        replacement = await canonical(replace) if replace is not None else None
        return apply_delta(m.tags, s, add=additions, remove=removals, replace=replacement,
                           source=source, rules=await scoped_rules(m, rules))

    changed = await _mutate(message_id, change, wake_worker=True)
    if source.source == "manual":
        from flow_sdk.stream_inbox.classification import moderated  # noqa: PLC0415

        moderated(changed)   # a labelled message's ground truth follows a person's change
    return changed


async def _request_automation(message_id: str) -> tuple[str, str, str, str] | None:
    """Attribute a worker's local CLI call only to its server-owned, active claim.

    A process header is a local-instance capability hint, not a remote identity.
    Authenticated remote callers must have a process-bound key. Client-supplied
    source/trigger/run fields never participate in attribution.
    """
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.builtin.flow_message import FlowMessage
    from flow_sdk.request_context.methods import get_current_request_info
    from flow_sdk.tags.envelope import parse_target
    from flow_sdk.utils.networking import is_loopback

    info = get_current_request_info()
    if info is None:
        return None
    key = getattr(info, "api_key", None)
    process_id = None
    if key is not None:
        kind, identity = parse_target(key.bind_typeid)
        process_id = identity if kind == "agentic_process" else None
    elif info.request is not None and info.request.client is not None and is_loopback(info.request.client.host):
        process_id = info.request.headers.get("X-Flow-Process-Id")
    if not process_id:
        return None
    process = await AgenticProcess.get_by_id(process_id)
    context = (process.context_data or {}).get("automation", {}) if process else {}
    if context.get("subject_id") != message_id:
        return None
    message = await FlowMessage.get_by_id(message_id)
    if message is not None and message.message_processing is not None:
        for entry in message.message_processing.queue:
            if (entry.status == "running" and entry.trigger_id == context.get("trigger_id")
                    and entry.run_id == context.get("run_id")):
                return message_id, entry.trigger_id, entry.run_id, entry.tag
    return None


def wake(message_id: str) -> None:
    from flow_sdk.request_context.detached import create_detached_task, add_detached_done_callback

    task = create_detached_task(single_flight(_drains, message_id, lambda: process_message(message_id),
                                            "Message processing failed: %s"), name=f"message-tags:{message_id}")
    _tasks.add(task)
    add_detached_done_callback(task, _tasks.discard)


async def message_context(message):
    """What the classifier reads of ``message`` (a FlowMessage, or its state): the classifier's input, and the
    ``input`` of the message's ground-truth row -- one builder, so an eval measures what a run sees."""
    from flow_sdk.schema.data_spec.message_state_spec import MessageState
    from flow_sdk.schema.data_spec.tag_classification_spec import MessageContextSpec
    from flow_sdk.stream_inbox.message_subject import _self_ids, state_of

    state = message if isinstance(message, MessageState) else state_of(message, await _self_ids(), allow_foreign_agents=True)
    return MessageContextSpec(message=state)


async def classify(message, definitions: list[dict[str, str]]):
    """One tag for ``message`` out of ``definitions`` — the generic classifier, on the message's context."""
    from flow_sdk.tags.classify import choose

    return await choose(await message_context(message), {d["name"]: d["description"] or d["name"] for d in definitions})


async def _classify(message):
    from flow_sdk.schema.data_spec.returned_value_spec import ExitCode

    claimed = forced = False

    def claim(m, s):
        nonlocal claimed, forced
        if s.classification == "pending":
            s.classification, claimed = "running", True
            forced, s.classification_forced = s.classification_forced, False
        return m.tags

    await _mutate(str(message.id), claim)
    if not claimed:
        return
    error = ""
    tags = []
    enabled = forced or await classifier_on()
    try:
        definitions = await ontology() if enabled else []
        if definitions:
            answer = await classify(message, definitions)
            if answer.exit_code is not ExitCode.OK or not answer.has_value:
                raise ValueError(answer.detail or "Classification returned no successful value.")
            tag = getattr(answer.value, "tag", None)
            if tag and tag not in {d["name"] for d in definitions}:
                raise ValueError("Classification returned a tag outside the configured ontology.")
            tags = [tag] if tag else []  # "none of these" leaves the message untagged
    except Exception as exc:
        error = str(exc)
    async def finish(m, s):
        from flow_sdk.builtin.tag import resolve_tag

        rules = await _rules()
        s.classification = "failed" if error else "succeeded" if enabled else "skipped"
        s.classification_error = error
        current_tags = []
        for name in tags if not error else ():
            if name in s.suppressed_tags:
                continue
            definition = await resolve_tag(name)
            if definition is not None and not definition.deprecated:
                current_tags.append(definition.name)
        return apply_delta(m.tags, s, add=current_tags,
                           source=TagAssignment(source="classification"), rules=await scoped_rules(m, rules))

    await _mutate(str(message.id), finish)


async def preview(rule, *, state=None, text=None, message_id=None):
    """Existing decision preview, with no tag writes, queue admission or execution."""
    from flow_sdk.builtin.flow_message import FlowMessage
    from flow_sdk.schema.data_spec.message_state_spec import MessageState
    from flow_sdk.schema.data_spec.returned_value_spec import DecisionVerdict, ExitCode

    identity = message_id or getattr(state, "message_id", "")
    if identity:
        message = await FlowMessage.get_by_id(identity)
        if message is None:
            return DecisionVerdict.not_found("No such message.")
        if not await scoped_rules(message, [rule]):
            return DecisionVerdict.not_yet("The message is outside this automation's sources.", ran=False)
        tags = message.tags
    else:
        definitions = await ontology()
        try:
            answer = await classify(state or MessageState.from_text(text or ""), definitions)
            if answer.exit_code is not ExitCode.OK or not answer.has_value:
                return DecisionVerdict.not_yet(answer.detail or "Classification unavailable.", ran=False)
            tags = [answer.value.tag] if answer.value.tag else []
        except Exception as exc:
            return DecisionVerdict.not_yet(str(exc), ran=False)
    tag = matching_tag(rule, tags)
    reason = f"Matches tag {tag}." if tag else "No qualifying message tag."
    return (DecisionVerdict.satisfied(met=True, confidence=1.0, reason=reason, ran=False) if tag
            else DecisionVerdict.not_yet(reason, met=False, confidence=1.0, reason=reason, ran=False))


async def process_message(message_id: str) -> None:
    from flow_sdk.builtin.flow_message import FlowMessage
    from flow_sdk.builtin.trigger import Trigger
    from flow_sdk.builtin import tag_triggers
    from flow_sdk.builtin.trigger_arming import runs_here

    message = await FlowMessage.get_by_id(message_id)
    if message is None or message.message_processing is None:
        return
    if message.message_processing.classification == "pending":
        await _classify(message)
    while True:
        message = await FlowMessage.get_by_id(message_id)
        if message is None or message.message_processing is None:
            return
        state = message.message_processing
        if state.classification == "running" or any(e.status in {"running", "interrupted"} for e in state.queue):
            return
        entry = next((e for e in state.queue if e.status == "queued" and e.tag), None)
        if entry is None:
            return
        # Use the existing rule lock as well as message FIFO: two messages must not
        # collide with the same Wizard's activity slot or drop a busy admission.
        async with tag_triggers._locks.setdefault(entry.trigger_id, asyncio.Lock()):
            rule = await Trigger.get_by_id(entry.trigger_id)
            from flow_sdk.automations.lifecycle import may_run

            runnable = rule is not None and await runs_here(rule) and await may_run(rule)
            claimed = False

            async def claim(m, s):
                nonlocal claimed, rule
                # Read configuration under the same writer boundary as the claim:
                # a tag rename/delete must not race a stale trigger snapshot.
                rule = await Trigger.get_by_id(entry.trigger_id)
                live = next((e for e in s.queue if e.id == entry.id), None)
                if live is None or live.status != "queued":
                    return m.tags
                if not runnable or rule is None or not rule.enabled or rule.ended_at or not await scoped_rules(m, [rule]):
                    live.status, live.error = "skipped", "Automation is disabled, ended, missing or runs elsewhere."
                elif not matching_tag(rule, m.tags):
                    live.status, live.error = "cancelled", "The message no longer carries a qualifying tag."
                else:
                    live.status, claimed = "running", True
                return m.tags

            await _mutate(message_id, claim)
            if not claimed:
                continue
            cause = await message_event(message)
            token = automation_assignment.set((message_id, entry.trigger_id, entry.run_id, entry.tag))
            try:
                result = await tag_triggers._run_tag_fire(rule, cause, None, is_test=False, run_id=entry.run_id)
                status = "failed" if result.get("error") else "succeeded" if result.get("accepted") else "skipped"
                error = result.get("error") or result.get("reason_code") or ""
                if result.get("agentic_process_id") and not rule.then:
                    # A legacy launch has no completed result; never treat admission as completion.
                    status, error = "interrupted", "Legacy automation launched work without an awaited outcome."
            except asyncio.CancelledError:
                raise  # durable running claim is reconciled, never replayed
            except Exception as exc:
                status, error = "failed", str(exc)
            finally:
                automation_assignment.reset(token)

            def finish(m, s):
                live = next((e for e in s.queue if e.id == entry.id), None)
                if live is not None and live.status == "running":
                    live.status, live.error = status, error
                return m.tags

            await _mutate(message_id, finish)


async def classify_now(message_id: str):
    """A person asks for this message to be classified now — whatever the switch says, and again
    after a failure. A classification already under way is left alone."""
    rule = await classifier()

    def ask(m, s):
        if s.classification in {"pending", "running"}:
            return m.tags
        s.classification, s.classification_error, s.classification_forced = "pending", "", True
        if not any(not e.tag for e in s.queue):
            s.queue[:0] = _classifier_entry(rule)
        return m.tags

    return await _mutate(message_id, ask, wake_worker=True)


async def apply_classification(message_id: str, tag: str):
    """A person makes a dry run's answer the message's classification: the tag the classifier gave before
    goes, ``tag`` takes its place, tags a person added stay. Starts no automation."""
    if tag not in {d["name"] for d in await ontology()}:
        raise ValueError("The tag is outside the configured classification tree.")
    return await retag_as_classification(
        message_id, add=[tag], remove=lambda m, s: [t for t, a in s.assignments.items() if a.source == "classification" and t != tag])


async def retag_as_classification(message_id: str, *, add, remove, rules=None):
    """An applied classification on one message: ``add`` goes on (a person's earlier removal of it is forgotten),
    ``remove`` -- names, or ``(message, state) -> names`` read inside the write -- goes off. Nothing is queued.
    ``rules`` spares the read when one caller retags many messages."""
    add = list(add)
    rules = await _rules() if rules is None else rules

    async def change(m, s):
        s.suppressed_tags = [t for t in s.suppressed_tags if t not in add]
        # A person settled where this message belongs -- "no tag fits" included -- so it is classified,
        # and no longer waits for a classification. One already under way keeps its own state.
        if s.classification not in {"pending", "running"}:
            s.classification, s.classification_error = "succeeded", ""
        return apply_delta(m.tags, s, add=add, remove=remove(m, s) if callable(remove) else remove,
                           source=TagAssignment(source="classification"),
                           rules=await scoped_rules(m, rules), start_automations=False)

    return await _mutate(message_id, change)


async def run_again(message_id: str, entry_id: str):
    """A person asks for one failed or interrupted automation to run again on this message: a new
    run, queued behind whatever is running. Nothing is ever replayed by itself."""
    found = False

    def requeue(m, s):
        nonlocal found
        entry = next((e for e in s.queue if e.id == entry_id and e.tag), None)
        if entry is not None and entry.status in {"failed", "interrupted"}:
            entry.status, entry.error, entry.run_id, found = "queued", "", str(mint_uuid()), True
        return m.tags

    message = await _mutate(message_id, requeue, wake_worker=True)
    return message if found else None


async def enrolled_messages() -> list:
    """Every message that was enrolled for classification, as stored."""
    from flow_sdk.builtin.flow_message import FlowMessage
    from flow_sdk.db.drivers.query import QueryFilter, ExpressionNode, QueryOp

    return await FlowMessage.get_all(QueryFilter(match=ExpressionNode(
        op=QueryOp.IS_NOT_NULL, operands=["message_processing"])), hydrate=False)


async def reconcile() -> None:
    """Boot recovery reads only enrolled messages. An uncertain fire is never replayed."""
    from flow_sdk.builtin.trigger import Trigger

    for row in await enrolled_messages():
        state = row.message_processing
        # A settled message has nothing to recover and nothing to run: leave its row alone.
        if state.classification not in {"pending", "running"} and not any(
                entry.status in {"queued", "running"} for entry in state.queue):
            continue
        completed = {}
        for entry in row.message_processing.queue:
            if entry.status == "running" and entry.run_id:
                run = await Trigger.run(entry.run_id)
                if (run is not None and run.trigger_id == entry.trigger_id
                        and run.status in {"succeeded", "failed", "skipped"}):
                    completed[entry.id] = (run.status, run.error or "")
        def recover(m, s):
            if s.classification == "running":
                s.classification, s.classification_error = "failed", "Classification was interrupted."
            for entry in s.queue:
                if entry.status == "running":
                    entry.status, entry.error = completed.get(entry.id, (
                        "interrupted", "Execution was interrupted; it was not replayed."))
            return m.tags
        await _mutate(str(row.id), recover)
        wake(str(row.id))
