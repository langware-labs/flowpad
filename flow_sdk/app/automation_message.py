"""Flowpad posting its own answer into a conversation -- a diagnosis, what an automation found.

One way for both: the message is written locally (``handle_add_message``), its details ride as a
``<kind>.value.json`` file a viewer opens by kind, and its arrival is the one notification
(CLAUDE.md "Notifications = message arrival only"). An automation's own messages go to ITS conversation
on the Automations channel -- one per automation, found again by the trigger it belongs to -- each drawn
by its ``card.value.json``. What a real run answered goes where its rule reports (``report_run``): the
conversation of the message that fired it, as a private message, or that same Automations conversation.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.conversation_channel import AUTOMATIONS
from flow_sdk.builtin.flow_message import APP_FILE, CARD_FILE, FlowMessageKind
from flow_sdk.responses.response import ApiSuccessResponse
from flow_sdk.schema.data_spec.automation_spec import AutomationRef, AutomationResult, AutomationResultStatus

logger = logging.getLogger(__name__)


class Upload:
    """An in-memory file for the message send (what an upload looks like to it)."""

    def __init__(self, filename: str, content: bytes) -> None:
        self.filename = filename
        self._content = content

    async def read(self) -> bytes:
        return self._content


def as_card(value: Any) -> dict:
    """A value as a value file holds it: its fields, tagged with its kind."""
    from flow_sdk.schema.data_spec.spec import spec_tag  # noqa: PLC0415

    return {"spec_kind": spec_tag(value), **value.model_dump(mode="json")}


def value_json(value: Any) -> bytes:
    """A value as the ``.value.json`` a viewer opens by its kind."""
    return json.dumps(as_card(value), indent=2).encode("utf-8")


async def post_message(
    conversation_id: str,
    text: str,
    *,
    kind: FlowMessageKind,
    sender_name: str,
    someone: str,
    files: Optional[dict[str, bytes]] = None,
    asset_references: Optional[list[str]] = None,
    private: bool = False,
    app: Any = None,
) -> Optional[str]:
    """Write Flowpad's message into the conversation and raise its arrival; the new message's id.
    ``private``: a private message -- this machine's user reads it there and shares or dismisses it.
    ``app``: an app message's ``MessageAppSpec``, written with the row."""
    from flow_sdk.app.actions.notification_action import handle_add_message  # noqa: PLC0415
    from flow_sdk.notifications import notify_message_arrival  # noqa: PLC0415

    body: dict[str, Any] = {
        "conversation_id": conversation_id,
        "text": text,
        "kind": kind.value,
        "files": [Upload(n, c) for n, c in (files or {}).items()],
    }
    if private:  # shown under the automation's name until it is shared, when it becomes the person's own
        body.update(private=True, sender_name=sender_name)
    if asset_references:
        body["asset_references"] = list(asset_references)
    added = await handle_add_message(body, someone, app=app)
    message_id = (added.data or {}).get("id") if isinstance(added, ApiSuccessResponse) else None
    if message_id:
        await notify_message_arrival(conversation_id, message_id, sender_name=sender_name, text=text)
    return message_id


async def automation_conversation(automation: AutomationRef, someone: str) -> Conversation:
    """The automation's own conversation on the Automations channel -- found by its trigger, or written."""
    found = await find_automation_conversation(automation.trigger_id)
    if found is not None:
        return found
    conv = Conversation(title=automation.name or "Automation")
    conv.channel = AUTOMATIONS.name
    conv.channel_source_id = f"trigger-{automation.trigger_id}"
    return await conv.save(someone)


async def find_automation_conversation(trigger_id: str) -> Optional[Conversation]:
    """The automation's conversation when it has one; a lookup, nothing is written."""
    return await Conversation.get_one({"channel": AUTOMATIONS.name, "channel_source_id": f"trigger-{trigger_id}"})


async def set_app_status(message_id: str, status: AutomationResultStatus) -> None:
    """Where an app message's work stands now (its chip). Read fresh and saved: the row's update is its notice."""
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415

    message = await FlowMessage.get_by_id(message_id)
    if message is not None and message.app is not None and message.app.status != status:
        message.app = message.app.model_copy(update={"status": status})
        await message.save()


async def post_automation_result(automation: AutomationRef, result: AutomationResult, value: Any = None, *,
                                 asset_references: Optional[list[str]] = None,
                                 conversation: Optional[Conversation] = None) -> Optional[str]:
    """Post what an automation did into its conversation, as a card: ``result`` its Status, Summary and
    Details (``card.value.json``, drawn in place by the ``automation.result`` viewer; the message's text is the
    summary), ``value`` what it found (``<kind>.value.json``), when it found something. Answers the message id."""
    from flow_sdk.server.routes.bootstrap import get_or_create_local_user  # noqa: PLC0415

    someone = (await get_or_create_local_user()).typeid
    conv = conversation or await automation_conversation(automation, someone)
    return await post_message(
        conv.id, result.summary,
        kind=FlowMessageKind.AUTOMATION_RESULT,
        sender_name=automation.name or "Automation",
        someone=someone,
        # The card first: it is what the message is drawn by; what was found rides beside it.
        files={CARD_FILE: value_json(result),
               **({f"{value.spec_kind}.value.json": value_json(value)} if value is not None else {})},
        asset_references=asset_references,
    )


async def post_app_message(automation: AutomationRef, html: str, value: Any, *,
                           status: Optional[AutomationResultStatus] = None, data: Optional[dict] = None) -> Optional[str]:
    """Post an APP MESSAGE into the automation's conversation: the nano-app ``html`` (``app.html``) and the
    ``value`` it opens on (``<kind>.value.json``). The conversation draws the app's block slot in the bubble;
    its ``app.header`` -- and its text -- is the app's header slot filled from ``data``, ``app.status`` where
    the work stands, so a list row and the arrival notice read right with no frame. Answers the message id."""
    from flow_sdk.schema.data_spec.message_app_spec import MessageAppSpec  # noqa: PLC0415
    from flow_sdk.schema.data_spec.nano_app_spec import read_nano_app, render_header  # noqa: PLC0415
    from flow_sdk.server.routes.bootstrap import get_or_create_local_user  # noqa: PLC0415

    if read_nano_app(html) is None:
        raise ValueError("an app message carries a nano-app: the page has no nano-app manifest")
    header = render_header(html, data or {})
    someone = (await get_or_create_local_user()).typeid
    conv = await automation_conversation(automation, someone)
    return await post_message(
        conv.id, header, kind=FlowMessageKind.AUTOMATION_RESULT, sender_name=automation.name or "Automation",
        someone=someone, files={APP_FILE: html.encode("utf-8"), f"{value.spec_kind}.value.json": value_json(value)},
        app=MessageAppSpec(status=status, header=header),
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
    if last is not None and last.card() == as_card(result):
        return None
    return await post_automation_result(automation, result, conversation=conv)


async def report_run(trigger: Any, execution: Any) -> Optional[str]:
    """Post what a real run answered where its rule reports (``Trigger.report_to``): into the conversation of
    the message that fired it, as a private message, or into the rule's Automations conversation. The answer
    is the last step's: what it said (an agent's reply, a script's output), and its value as
    ``card.value.json`` when it returned one. Nothing is posted for a run that said nothing, or a rule that
    reports nowhere."""
    from flow_sdk.schema.data_spec.returned_value_spec import ExitCode  # noqa: PLC0415
    from flow_sdk.schema.data_spec.spec import DataSpec  # noqa: PLC0415
    from flow_sdk.server.routes.bootstrap import get_or_create_local_user  # noqa: PLC0415

    answer = execution.answer
    if answer is None or answer.exit_code is not ExitCode.OK:
        return None
    value = answer.value if isinstance(answer.value, DataSpec) else None
    text = (getattr(answer, "text", "") or getattr(answer, "stdout", "") or "").strip()
    if not text and value is None:
        return None
    conversation_id = str(getattr(execution.state, "conversation_id", "") or "")
    private = bool(conversation_id) and trigger.report_to in (None, "", "conversation")
    if not private and trigger.report_to != "automations":
        return None
    someone = (await get_or_create_local_user()).typeid
    if not private:
        ref = AutomationRef(trigger_id=str(trigger.id), name=trigger.name or "")
        conversation_id = (await automation_conversation(ref, someone)).id
    return await post_message(
        conversation_id, text,
        kind=FlowMessageKind.USER if private else FlowMessageKind.AUTOMATION_RESULT,
        sender_name=trigger.name or "Automation",
        someone=someone,
        files={CARD_FILE: value_json(value)} if value is not None else None,
        private=private,
    )
