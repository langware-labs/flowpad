"""Send a finished diagnosis to the people (and help desk) the person picked.

A diagnosis is sent like any message of mine: a conversation titled with the diagnosis one-liner,
the person's own words, then the diagnosis as ``diagnosis.value.json``. The outbox owns delivery, so
signed out, offline or refused, it waits and goes with the rest. Recipients get it the way they get
every message (unread counter, popup) -- nothing here is special to diagnoses.

People share one conversation; a help desk gets its own ticket (a desk conversation cannot also hold
a person). Both carry the same two messages. Nothing exists before the send: recipients never see a
conversation that is still being diagnosed.

Idempotent per ``conversation_id``: sending again for the same id finds the conversation it already
wrote and sends nothing twice.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any, Optional

from pydantic import BaseModel, Field

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.schema.data_spec.help_request_spec import HelpRecipient, HelpRecipientKind

logger = logging.getLogger(__name__)

#: The ticket beside a people conversation is derived from its id, so a retry finds it again.
_DESK_NAMESPACE = uuid.UUID("6f1d3c52-6a8e-4c43-9a0e-4f2b9d3e7a11")


class DiagnoseShare(BaseModel):
    """What the person chose in the Diagnose window: who gets the results, and whether they go
    when the run finishes (``send_when_done``) or wait for a click (``diagnose-send``)."""

    recipients: list[HelpRecipient] = Field(default_factory=list)
    send_when_done: bool = False
    #: Minted by the window, kept across resubmits: the same id is the same send.
    conversation_id: Optional[str] = None
    project_id: Optional[str] = None


class Shared(BaseModel):
    conversation_id: str
    to: str


def desk_conversation_id(conversation_id: str) -> str:
    return mint_uuid(conversation_id, namespace=_DESK_NAMESPACE)


def recipients_label(recipients: list[HelpRecipient]) -> str:
    """"Eran Shlomo", "Eran Shlomo and the help desk" -- how a toast names who got it."""
    names = [r.name or r.email or ("the help desk" if r.kind is HelpRecipientKind.DESK else "") for r in recipients]
    names = [n for n in names if n]
    if len(names) <= 1:
        return names[0] if names else ""
    return f"{', '.join(names[:-1])} and {names[-1]}"


def _one_liner(diagnosis: Any) -> str:
    return (getattr(diagnosis, "title", "") or "").strip()


def title_of(diagnosis: Any, user_report: str) -> str:
    """The conversation title: the diagnosis one-liner, else the first line of what the person said,
    cut by the hub's ticket rule so a desk ticket and a people conversation read the same."""
    from flow_sdk.app.actions.flow_message_action import _ticket_title  # noqa: PLC0415

    line = _one_liner(diagnosis) or (user_report or "").strip()
    return _ticket_title(line) if line else "Flowpad diagnosis"


def opening_text(diagnosis: Any, user_report: str, *, desk: bool) -> str:
    """The first message's text. The hub titles a ticket by its opening line (``_ticket_title``), so on
    a desk the one-liner goes first, then the person's words -- the shape Ask for help sends."""
    return "\n\n".join(p for p in (_one_liner(diagnosis) if desk else "", (user_report or "").strip()) if p)


async def _capture(conv_id: str, title: str, people: list[HelpRecipient], desk: Optional[HelpRecipient],
                   project_id: Optional[str], someone: str):
    """The conversation for ``conv_id`` -- found, or written (not yet delivered). True when written."""
    from flow_sdk.builtin.conversation import Conversation, ConversationKind  # noqa: PLC0415

    conv = await Conversation.get_one({"id": conv_id})
    if conv is not None:
        return conv, False
    if desk is not None:
        from flow_sdk.app.actions.flow_message_action import resolve_desk_here  # noqa: PLC0415

        desk_id = desk.desk_project_id
        if not desk_id:
            known = await resolve_desk_here(project_id)
            desk_id = known.project_id if known else None  # unknown offline: resolved at delivery
        conv = Conversation(id=conv_id, title=title, kind=ConversationKind.HELPDESK, remote_project_id=desk_id)
    else:
        from flow_sdk.app.actions.ask_for_help_action import member_of  # noqa: PLC0415

        conv = Conversation(id=conv_id, title=title, members=[member_of(p) for p in people])
    conv.awaits_hub = True
    conv.origin_project_id = project_id
    return await conv.save(someone), True


async def _write_messages(conv, diagnosis: Any, user_report: str, someone: str) -> bool:
    """The person's words, then the diagnosis as its own message with ``diagnosis.value.json``."""
    from flow_sdk.app.actions.ask_for_help_action import DIAGNOSIS_FILE, _Upload, diagnosis_text  # noqa: PLC0415
    from flow_sdk.app.actions.notification_action import handle_add_message  # noqa: PLC0415
    from flow_sdk.builtin.conversation import ConversationKind  # noqa: PLC0415
    from flow_sdk.responses.response import ApiSuccessResponse  # noqa: PLC0415
    from flow_sdk.schema.data_spec.spec import spec_tag  # noqa: PLC0415

    desk = conv.kind in (ConversationKind.HELPDESK, ConversationKind.HELPDESK.value)
    opening = opening_text(diagnosis, user_report, desk=desk)
    if opening:
        said = await handle_add_message({"conversation_id": conv.id, "text": opening}, someone)
        if not isinstance(said, ApiSuccessResponse):
            logger.warning("[diagnose-share] request text not written to %s: %s", conv.id, said.message)
            return False
    content = json.dumps({"spec_kind": spec_tag(diagnosis), **diagnosis.model_dump(mode="json")}, indent=2)
    sent = await handle_add_message(
        {
            "conversation_id": conv.id,
            "text": diagnosis_text(diagnosis, desk=desk),
            "files": [_Upload(DIAGNOSIS_FILE, content.encode("utf-8"))],
        },
        someone,
    )
    if not isinstance(sent, ApiSuccessResponse):
        logger.warning("[diagnose-share] diagnosis not written to %s: %s", conv.id, sent.message)
        return False
    return True


async def send_diagnosis_to(share: DiagnoseShare, diagnosis: Any, user_report: str, someone: str) -> list[Shared]:
    """Write and send the diagnosis to every picked recipient. Never raises: a lost send is logged
    and left out of the answer, and the diagnosis stays recorded on this computer either way."""
    people = [r for r in share.recipients if r.kind is HelpRecipientKind.PERSON]
    desks = [r for r in share.recipients if r.kind is HelpRecipientKind.DESK]
    if not people and not desks:
        return []
    base = share.conversation_id or str(uuid.uuid4())
    title = title_of(diagnosis, user_report)
    plan: list[tuple[str, list[HelpRecipient], Optional[HelpRecipient]]] = []
    if people:
        plan.append((base, people, None))
    if desks:
        plan.append((desk_conversation_id(base) if people else base, [], desks[0]))

    async def _one(conv_id: str, to_people: list[HelpRecipient], desk: Optional[HelpRecipient]) -> Optional[Shared]:
        try:
            conv, written = await _capture(conv_id, title, to_people, desk, share.project_id, someone)
            if written and not await _write_messages(conv, diagnosis, user_report, someone):
                return None
            try:
                await conv.deliver(bodies=False)
            except Exception as e:  # noqa: BLE001 -- the outbox retries; the send stands
                logger.info("[diagnose-share] first delivery of %s failed: %s", conv.id, e)
            conv.kick_delivery()
            return Shared(conversation_id=conv.id, to=recipients_label(to_people or [desk]))
        except Exception as e:  # noqa: BLE001 -- one recipient's failure never costs the others
            logger.warning("[diagnose-share] sending to %s failed: %s", conv_id, e, exc_info=True)
            return None

    # The people conversation and the desk ticket are independent: neither waits on the other's hub hop.
    return [s for s in await asyncio.gather(*(_one(*p) for p in plan)) if s is not None]
