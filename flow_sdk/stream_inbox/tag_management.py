"""Stream Inbox tag management: keep bindings and automation references with the name.

Generic Tag deletion still only unblesses an anonymous tag. These explicit
message-management operations own the stronger Stream Inbox confirmation semantics.
"""
from __future__ import annotations

from flow_sdk.tags.grammar import normalize_tag


async def _affected(tag):
    from flow_sdk.builtin.flow_message import FlowMessage
    from flow_sdk.builtin.trigger import Trigger
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp
    from flow_sdk.schema.data_spec.trigger_types import TriggerType

    messages = [m for m in await FlowMessage.get_all(QueryFilter(match=ExpressionNode(
        op=QueryOp.LIKE, operands=["tags", f'%"{tag.name}"%'])), hydrate=False) if tag.name in m.tags]
    rules = [rule for rule in await Trigger.list_by_type(TriggerType.TAG) if tag.name in rule.message_tags]
    return messages, rules


async def impact(tag) -> dict:
    messages, rules = await _affected(tag)
    return {"messages": len(messages), "automations": len(rules)}


def _editable(tag):
    if tag.system:
        raise ValueError("Flowpad tags cannot be renamed or deleted.")


async def rename(tag, fields: dict) -> dict:
    from flow_sdk.automations.spec_file import document_path, rewrite
    from flow_sdk.builtin.tag import Tag
    from flow_sdk.db import get_db_driver
    from flow_sdk.stream_inbox.message_tags import _mutate, enrolled_messages

    _editable(tag)
    if not isinstance(fields, dict) or not isinstance(fields.get("name"), str):
        raise ValueError("A new canonical tag name is required.")
    name = normalize_tag(fields["name"])
    if name == tag.name:
        raise ValueError("Choose a different canonical tag name.")
    async with get_db_driver().write_transaction():
        if await Tag.get_by_id(Tag.allocate_id({"name": name})) is not None:
            raise ValueError("That tag already exists; rename does not merge tags.")
        successor = Tag(name=name, stream_inbox=tag.stream_inbox,
                        **{key: fields.get(key, getattr(tag, key)) for key in ("title", "description", "color")})
        messages, rules = await _affected(tag)
        message_count = len(messages)
        by_id = {str(message.id): message for message in messages}
        for message in await enrolled_messages():
            state = message.message_processing
            if (tag.name in state.suppressed_tags or tag.name in state.assignments
                    or any(entry.tag == tag.name for entry in state.queue)):
                by_id[str(message.id)] = message
        if any(rule.is_builtin for rule in rules):
            raise ValueError("A built-in automation references this tag and cannot be renamed here.")
        await successor.save()
        tag.alias_of, tag.deprecated = name, True
        await tag.save()
        for rule in rules:
            names = list(dict.fromkeys(name if old == tag.name else old for old in rule.message_tags))
            if document_path(rule) is not None:
                await rewrite(rule, {"message_tags": names})
            else:
                rule.message_tags = names
                await rule.save()

        def migrate(message, state):
            # Renaming identity is not a new assignment: preserve provenance and
            # once claims, including terminal/cancelled entries, without enqueue.
            if tag.name in state.assignments:
                assignment = state.assignments.pop(tag.name)
                state.assignments.setdefault(name, assignment)
            state.suppressed_tags = list(dict.fromkeys(name if old == tag.name else old for old in state.suppressed_tags))
            for entry in state.queue:
                if entry.tag == tag.name:
                    entry.tag = name
            return list(dict.fromkeys(name if old == tag.name else old for old in message.tags))

        for message in by_id.values():
            await _mutate(str(message.id), migrate)
    return {"tag": successor.model_dump(mode="json"), "messages": message_count, "automations": len(rules)}


async def delete(tag) -> dict:
    from flow_sdk.builtin.trigger import set_trigger_on
    from flow_sdk.db import get_db_driver
    from flow_sdk.stream_inbox.message_tags import _mutate, enrolled_messages

    _editable(tag)
    async with get_db_driver().write_transaction():
        messages, rules = await _affected(tag)
        if any(rule.is_builtin and not rule.switchable for rule in rules):
            raise ValueError("A built-in automation references this tag and cannot be disabled here.")
        affected = {str(rule.id) for rule in rules}
        message_count = len(messages)
        # A multi-tag rule can be queued on a message which no longer carries
        # this particular tag. Disabling that rule cancels those queued claims too.
        by_id = {str(message.id): message for message in messages}
        for message in await enrolled_messages():
            if any(entry.status == "queued" and entry.trigger_id in affected for entry in message.message_processing.queue):
                by_id[str(message.id)] = message
        for rule in rules:
            await set_trigger_on(rule, False)

        def detach(message, state):
            state.assignments.pop(tag.name, None)
            state.suppressed_tags = sorted(set(state.suppressed_tags) | {tag.name})
            for entry in state.queue:
                if entry.status == "queued" and (entry.trigger_id in affected or entry.tag == tag.name):
                    entry.status, entry.error = "cancelled", "The triggering tag was deleted."
            return [name for name in message.tags if name != tag.name]

        for message in by_id.values():
            await _mutate(str(message.id), detach, wake_worker=True)
        await tag.delete()
    return {"messages": message_count, "automations": len(rules)}
