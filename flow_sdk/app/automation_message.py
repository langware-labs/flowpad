"""Flowpad posting its own answer into a conversation -- a diagnosis, what an automation found.

One way for both: the message is written locally (``handle_add_message``), its details ride as a
``<kind>.value.json`` file a viewer opens by kind, and its arrival is the one notification
(CLAUDE.md "Notifications = message arrival only"). An automation answers in ITS conversation on
the Automations channel -- one per automation, found again by the trigger it belongs to.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.conversation_channel import AUTOMATIONS
from flow_sdk.builtin.flow_message import FlowMessageKind
from flow_sdk.responses.response import ApiSuccessResponse
from flow_sdk.schema.data_spec.automation_spec import AutomationRef, AutomationResult

logger = logging.getLogger(__name__)


class Upload:
    """An in-memory file for the message send (what an upload looks like to it)."""

    def __init__(self, filename: str, content: bytes) -> None:
        self.filename = filename
        self._content = content

    async def read(self) -> bytes:
        return self._content


def value_json(value: Any) -> bytes:
    """A value as the ``.value.json`` a viewer opens by its kind."""
    from flow_sdk.schema.data_spec.spec import spec_tag  # noqa: PLC0415

    return json.dumps({"spec_kind": spec_tag(value), **value.model_dump(mode="json")}, indent=2).encode("utf-8")


async def post_message(
    conversation_id: str,
    text: str,
    *,
    kind: FlowMessageKind,
    sender_name: str,
    someone: str,
    files: Optional[dict[str, bytes]] = None,
    asset_references: Optional[list[str]] = None,
    automation_result: Optional[AutomationResult] = None,
) -> Optional[str]:
    """Write Flowpad's message into the conversation and raise its arrival; the new message's id."""
    from flow_sdk.app.actions.notification_action import handle_add_message  # noqa: PLC0415
    from flow_sdk.notifications import notify_message_arrival  # noqa: PLC0415

    body: dict[str, Any] = {
        "conversation_id": conversation_id,
        "text": text,
        "kind": kind.value,
        "files": [Upload(n, c) for n, c in (files or {}).items()],
    }
    if asset_references:
        body["asset_references"] = list(asset_references)
    added = await handle_add_message(body, someone, automation_result=automation_result)
    message_id = (added.data or {}).get("id") if isinstance(added, ApiSuccessResponse) else None
    if message_id:
        await notify_message_arrival(conversation_id, message_id, sender_name=sender_name, text=text)
    return message_id


async def automation_conversation(automation: AutomationRef, someone: str) -> Conversation:
    """The automation's own conversation on the Automations channel -- found by its trigger, or written."""
    key = f"trigger-{automation.trigger_id}"
    found = await Conversation.get_one({"channel": AUTOMATIONS.name, "channel_source_id": key})
    if found is not None:
        return found
    conv = Conversation(title=automation.name or "Automation")
    conv.channel = AUTOMATIONS.name
    conv.channel_source_id = key
    return await conv.save(someone)


async def post_automation_result(automation: AutomationRef, result: AutomationResult, value: Any = None, *,
                                 asset_references: Optional[list[str]] = None,
                                 conversation: Optional[Conversation] = None) -> Optional[str]:
    """Post what an automation did into its conversation, as a card: ``result`` its Status, Summary and
    Details (the message's text is the summary), ``value`` what it found (``<kind>.value.json``), when it
    found something. Answers the message id."""
    from flow_sdk.server.routes.bootstrap import get_or_create_local_user  # noqa: PLC0415

    someone = (await get_or_create_local_user()).typeid
    conv = conversation or await automation_conversation(automation, someone)
    return await post_message(
        conv.id, result.summary,
        kind=FlowMessageKind.AUTOMATION_RESULT,
        sender_name=automation.name or "Automation",
        someone=someone,
        files={f"{value.spec_kind}.value.json": value_json(value)} if value is not None else None,
        asset_references=asset_references,
        automation_result=result,
    )


async def post_failure(automation: AutomationRef, error: str) -> Optional[str]:
    """A real run failed: say so in the automation's conversation -- once per streak. A rule that keeps
    failing the same way has already said it, so its newest message is left to stand."""
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415
    from flow_sdk.server.routes.bootstrap import get_or_create_local_user  # noqa: PLC0415

    conv = await automation_conversation(automation, (await get_or_create_local_user()).typeid)
    newest = conv.latest_message_ref()  # one row read, however long the conversation is
    last = await FlowMessage.get_by_id(newest.id) if newest else None
    result = AutomationResult.of("failed", f"{automation.name or 'The automation'} could not run.", {"Error": error})
    if last is not None and last.automation_result == result:
        return None
    return await post_automation_result(automation, result, conversation=conv)
