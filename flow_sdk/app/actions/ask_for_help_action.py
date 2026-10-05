"""Asking for help — ONE action for both channels (docs/collab/ask-for-help.md).

``ask-for-help`` asks a person (a task assigned to them, discussed in a conversation) or a desk (a
ticket in its queue). It writes the request HERE first and answers once it is written — the hub is
reached afterwards, by ``Conversation.deliver``, whose stage 0 (``open_on_hub``, below) creates the
conversation there. So signing in, the network and the hub decide when a request arrives, never
whether it exists; and the same ``conversation_id`` is the same request, however often it is sent.

POST /api/v1/graph/ask-for-help        — capture, then one delivery attempt
POST /api/v1/graph/help-recipients     — the desks this person can ask, nearest first
POST /api/v1/graph/help-requests       — my requests, both kinds, one row shape
POST /api/v1/graph/conversation/<id>/resend — the person's Retry: deliver it again, refusals included
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Optional

import httpx
from pydantic import ValidationError

from flow_sdk.actions.action_registry import action
from flow_sdk.api.api_types.identifier import is_valid_entity_id, mint_uuid
from flow_sdk.app.actions.share_action import LOCAL_MODE_SHARE_MESSAGE, _local_mode_share_blocked
from flow_sdk.builtin.conversation import Conversation, ConversationKind
from flow_sdk.builtin.flow_message import DeliveryStatus, FlowMessage, delivery_rank
from flow_sdk.builtin.task import Task
from flow_sdk.cloud_client.shared.errors import HubError
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.db.drivers.query import QueryFilter
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.schema.data_spec.help_request_spec import AskForHelpRequest, HelpRecipient, HelpRecipientKind
from flow_sdk.schema.data_spec.hub_failure_spec import HubFailure, HubFailureKind

logger = logging.getLogger(__name__)

#: The hub capability that lets a ticket be opened under the id this machine minted (hub f9ff57ace).
IDEMPOTENT_TICKETS = "idempotent_guest_conversation"


# ---------------------------------------------------------------------------
# ask-for-help
# ---------------------------------------------------------------------------


def _parse_request(body: dict) -> AskForHelpRequest:
    """The request from a JSON body, or from the ``request`` field of a multipart one (with files)."""
    raw = body.get("request")
    fields = json.loads(raw) if isinstance(raw, str) else (raw if isinstance(raw, dict) else body)
    return AskForHelpRequest.model_validate({k: v for k, v in fields.items() if k != "files"})


@action.post(action_name="ask-for-help", types=None)
async def ask_for_help() -> ApiResponse:
    """Write the request here, then try the hub once. SUCCESS whenever the request is written."""
    request_info = get_current_request_info()
    if not request_info or not request_info.someone_typeid:
        return ApiFailResponse(message="No authenticated user in request context")
    if _local_mode_share_blocked():
        return ApiFailResponse(message=LOCAL_MODE_SHARE_MESSAGE, status_code=403)
    body = await request_info.get_post_data() or {}
    try:
        ask = _parse_request(body)
    except (ValidationError, ValueError) as e:
        return ApiFailResponse(message=f"Invalid help request: {e}", status_code=400)
    if not ask.text.strip():
        return ApiFailResponse(message="Say what you need help with", status_code=400)
    if ask.conversation_id and not is_valid_entity_id(ask.conversation_id):
        return ApiFailResponse(message="conversation_id must be a UUID (v4/v5)", status_code=400)

    someone = request_info.someone_typeid
    conv, task, created = await _capture_conversation(ask, someone)
    opening = await _opening_message(conv)
    if opening is None:
        sent = await _write_opening_message(conv, task, ask, body.get("files"), someone)
        if not isinstance(sent, ApiSuccessResponse):
            if created:  # nothing of this request may stay behind half-written
                await _discard(conv, task)
            return sent
        opening = await FlowMessage.get_one({"id": sent.data["id"]})

    # One attempt now; the outbox owns every later one. Its outcome never changes the verdict.
    try:
        await conv.deliver(bodies=False)
        conv.kick_delivery()
    except Exception as e:  # noqa: BLE001
        logger.warning("[ask-for-help] first delivery attempt failed: %s", e, exc_info=True)
    opening = await FlowMessage.get_one({"id": opening.id})
    return ApiSuccessResponse(
        data={
            "conversation_id": conv.id,
            "task_id": task.id if task else None,
            "message_id": opening.id,
            "delivery": _delivery(opening),
        }
    )


async def _capture_conversation(ask: AskForHelpRequest, someone) -> tuple[Conversation, Optional[Task], bool]:
    """The request's conversation (and task, for a person) — found by the asker's id, or written."""
    conv_id = ask.conversation_id or mint_uuid()
    conv = await Conversation.get_one({"id": conv_id})
    task = await _task_of(conv_id) if ask.recipient.kind is HelpRecipientKind.PERSON else None
    if conv is not None:
        return conv, task, False

    recipient = ask.recipient
    if recipient.kind is HelpRecipientKind.DESK:
        from flow_sdk.app.actions.flow_message_action import _ticket_title, resolve_desk_here  # noqa: PLC0415

        desk_id = recipient.desk_project_id
        if not desk_id:
            known = await resolve_desk_here(ask.project_id)
            desk_id = known.project_id if known else None  # unknown offline: resolved at delivery
        conv = Conversation(
            id=conv_id,
            title=ask.title.strip() or _ticket_title(ask.text),
            kind=ConversationKind.HELPDESK,
            remote_project_id=desk_id,
        )
    else:
        task = await _write_task(ask, conv_id, someone)
        member = {
            k: v for k, v in (("email", recipient.email), ("user_id", recipient.user_id), ("name", recipient.name)) if v
        }
        conv = Conversation(id=conv_id, title=task.title, members=[member])
    conv.awaits_hub = True
    conv.origin_project_id = ask.project_id
    conv = await conv.save(someone)
    return conv, task, True


async def _task_of(conv_id: str) -> Optional[Task]:
    rows = await Task.get_all(QueryFilter(match={"origin_conversation": conv_id}, limit=1))
    return rows[0] if rows else None


async def _write_task(ask: AskForHelpRequest, conv_id: str, someone) -> Task:
    """The task a person is asked to do, in the project the asker was in — under the title asked,
    or the next free one ("… (2)") when a task already has it."""
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.schema.data_spec.task_spec import TaskKind  # noqa: PLC0415

    project = await Project.get_by_id(ask.project_id) if ask.project_id else None
    mount = getattr(project, "fs_storage_mount_path", None) if project else None
    base = (ask.title or ask.text.splitlines()[0]).strip()[:80] or "Help request"
    recipient = ask.recipient
    for n in range(1, 21):
        task = Task(
            title=base if n == 1 else f"{base} ({n})",
            description=ask.text,
            kind=TaskKind.VIBE,
            assignee=recipient.email or recipient.user_id,
            origin_conversation=conv_id,
        )
        if project is not None:
            task.project_id = project.id
        try:
            if mount:
                await task._prepare_for_storage(scope_root=Path(mount))  # noqa: SLF001 — the placement seam
            return await task.save(someone)
        except Exception as e:  # noqa: BLE001
            if "exist" not in str(e).lower():
                raise
    raise RuntimeError(f"no free task title for {base!r}")


async def _opening_message(conv: Conversation) -> Optional[FlowMessage]:
    """The request's first message, when an earlier send of the same request already wrote it."""
    rows = await FlowMessage.get_all(QueryFilter(match={"conversation_id": conv.id, "outbound": True}, limit=1))
    return rows[0] if rows else None


async def _write_opening_message(conv, task, ask: AskForHelpRequest, files, someone):
    """The opening message, through the same send every message takes (files, chips, context)."""
    from flow_sdk.app.actions.notification_action import handle_add_message  # noqa: PLC0415

    chips = [*ask.context, *([str(task.typeid)] if task else [])]
    text = ask.text.strip()
    if conv.kind == ConversationKind.HELPDESK.value or conv.kind == ConversationKind.HELPDESK:
        # A guest cannot list a ticket's messages on the desk before staff pick it up, so the
        # session the asker CHOSE to attach also travels as text the desk can read at once.
        excerpt = await _session_excerpt(ask.context)
        if excerpt:
            from flow_sdk.app.actions.flow_message_action import TICKET_TRANSCRIPT_CHARS  # noqa: PLC0415

            text = f"{text}\n\n--- agent session (last {TICKET_TRANSCRIPT_CHARS} chars) ---\n{excerpt}"
    body = {
        "conversation_id": conv.id,
        "text": text,
        **({"asset_references": chips, "shared_context_entities": chips} if chips else {}),
        **({"files": files} if files else {}),
    }
    return await handle_add_message(body, someone)


async def _session_excerpt(context: list[str]) -> Optional[str]:
    """A readable tail of the session the asker named — never one they did not."""
    from flow_sdk.app.actions.flow_message_action import _ticket_transcript_excerpt  # noqa: PLC0415
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess  # noqa: PLC0415

    for ref in context:
        if ref.startswith("claude_session-"):
            return await _ticket_transcript_excerpt(ref)
        if ref.startswith("agentic_process-"):
            process = await AgenticProcess.get_by_id(ref.split("-", 1)[1])
            session_id = getattr(process, "session_id", None) if process else None
            if session_id:
                return await _ticket_transcript_excerpt(f"claude_session-{session_id}")
    return None


async def _discard(conv: Conversation, task: Optional[Task]) -> None:
    for row in (conv, task):
        if row is None:
            continue
        try:
            await row.delete()
        except Exception as e:  # noqa: BLE001
            logger.warning("[ask-for-help] could not remove the half-written %s %s: %s", row.get_type(), row.id, e)


def _delivery(fm: FlowMessage) -> dict:
    failure = fm.delivery_failure
    return {
        "header": fm.delivery_status,
        "body": getattr(fm.body_status, "value", fm.body_status),
        "failure": failure.model_dump(mode="json") if failure and fm.owes_delivery else None,
    }


# ---------------------------------------------------------------------------
# Stage 0 of Conversation.deliver: put a captured request on the hub
# ---------------------------------------------------------------------------


async def open_on_hub(conv: Conversation, opening: FlowMessage) -> Optional[HubFailure]:
    """Create on the hub the conversation a request was captured in — ``None`` once it is there.

    A desk ask opens a ticket under the id minted here (with its opening message, which is then
    SENT). A person ask puts the task on the hub and gives it to them, then shares the
    conversation with them; the opening message follows in stage 1. Every step is safe to repeat.
    """
    try:
        if conv.kind == ConversationKind.HELPDESK.value or conv.kind == ConversationKind.HELPDESK:
            failure = await _open_ticket(conv, opening)
            if failure is not None:
                return failure
        else:
            await _open_person_ask(conv, opening)
    except HubError as e:
        return e.failure
    except httpx.HTTPError as e:  # a hop that does not speak HubError yet (Entity.share's client)
        return HubFailure(kind=HubFailureKind.OFFLINE, message=f"Can't reach the hub right now ({type(e).__name__}).")
    except Exception as e:  # noqa: BLE001 — the reason must land on the message, not in a log
        logger.warning("[ask-for-help] opening on the hub failed: %s", e, exc_info=True)
        return HubFailure(kind=HubFailureKind.SERVER_ERROR, message=str(e) or type(e).__name__)
    conv.awaits_hub = False
    conv.remote = True
    await conv.save()
    from flow_sdk.cloud_client.hub_bridge import hub_ws_bridge  # noqa: PLC0415

    hub_ws_bridge.remember_hub_conversation(conv.id)
    return None


async def _open_ticket(conv: Conversation, opening: FlowMessage) -> Optional[HubFailure]:
    from flow_sdk.app.actions.flow_message_action import resolve_helpdesk  # noqa: PLC0415
    from flow_sdk.cloud_client.transport.hub_http import get_info, hub_request  # noqa: PLC0415

    info = await get_info()
    if info is None:
        return HubFailure(kind=HubFailureKind.OFFLINE, message="Can't reach the hub right now.")
    if IDEMPOTENT_TICKETS not in (info.get("capabilities") or []):
        # An older hub would ignore our id and open a second ticket on every retry: wait for it.
        return HubFailure(  # passes when the hub is upgraded: retried, not refused
            kind=HubFailureKind.SERVER_ERROR,
            code="hub_too_old",
            message="The help desk needs a newer hub to take this.",
        )
    if not conv.remote_project_id:
        desk = await resolve_helpdesk(conv.origin_project_id)
        if desk is None:
            return HubFailure(
                kind=HubFailureKind.NOT_CONFIGURED, message="This hub has no help desk — ask a person instead."
            )
        conv.remote_project_id = desk.project_id
        await conv.save()

    payload = {
        "conversation_id": conv.id,
        "id": opening.id,
        "text": opening.text,
        "context": [str(c) for c in (opening.shared_context_entities or [])],
        "attachment": [a.model_dump(mode="json") for a in (opening.attachment or [])],
        **({"body_status": "uploading"} if opening.has_body() else {}),
    }
    data = await hub_request(
        "POST", BuiltinEntityType.PROJECT, conv.remote_project_id, "start_guest_conversation", payload=payload
    )
    if (data or {}).get("id") != conv.id:
        return HubFailure(
            kind=HubFailureKind.REJECTED, code="hub_too_old", message="The hub opened the ticket under another id."
        )
    if data.get("title"):
        conv.title = data["title"]
    if data.get("initiated_by"):
        conv.created_by = data["initiated_by"]
    if opening.has_body():
        from flow_sdk.builtin.flow_message import BodyStatus  # noqa: PLC0415

        opening.body_status = BodyStatus.UPLOADING
    await opening.mark_sent()
    return None


async def _open_person_ask(conv: Conversation, opening: FlowMessage) -> None:
    from flow_sdk.app.actions.task_assign_action import assign_on_hub  # noqa: PLC0415
    from flow_sdk.cloud_client.client_hooks import resolve_hub_credential  # noqa: PLC0415

    member = (conv.members or [{}])[0]
    email, user_id = member.get("email"), member.get("user_id")
    task = await _task_of(conv.id)
    if task is not None:
        if not task.reporter:
            task.reporter = await _my_email()
        await assign_on_hub(task, email=email, user_id=user_id, message=opening.text, someone_typeid=None)
    if not await resolve_hub_credential():
        raise HubError(0, "signed out", kind=HubFailureKind.SIGNED_OUT)
    await conv.share(
        recipients=[email] if email else None,
        recipient_user_ids=[user_id] if user_id and not email else None,
        deliver_messages=False,
    )


async def _my_email() -> Optional[str]:
    from flow_sdk.cli.auth.credentials import load_credentials  # noqa: PLC0415

    creds = load_credentials()
    return ((creds.user or {}).get("email") if creds else None) or None


# ---------------------------------------------------------------------------
# resend / help-recipients / help-requests
# ---------------------------------------------------------------------------


@action.post(action_name="resend", types=["conversation"])
async def resend() -> ApiResponse:
    """``POST /graph/conversation/<id>/resend`` — the person's Retry: deliver what is owed, including
    what the hub refused before (they may have changed something since)."""
    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        return ApiFailResponse(message="resend: target conversation required", status_code=400)
    conv = await Conversation.get_one({"id": request_info.target_entity_typeid.id})
    if conv is None:
        return ApiFailResponse(message="Conversation not found", status_code=404)
    await conv.deliver(force=True)
    owed = await conv._owed_messages(force=True)  # noqa: SLF001
    return ApiSuccessResponse(data={"conversation_id": conv.id, "owed": len(owed)})


@action.post(action_name="help-recipients", types=None)
async def help_recipients() -> ApiResponse:
    """The desks this person can ask, nearest first: the project's own desk (a portal), a desk the
    project adopted, then the hub's ("Flowpad support"). ``default_state`` tells the dialog whether
    there is no desk (``not_configured``) or it cannot tell right now (``unknown``)."""
    from flow_sdk.app.actions.flow_message_action import _hub_default_helpdesk  # noqa: PLC0415
    from flow_sdk.app.helpdesk_resolver import resolve_adopted_helpdesk  # noqa: PLC0415
    from flow_sdk.cloud_client.transport.hub_http import get_info  # noqa: PLC0415

    request_info = get_current_request_info()
    body = (await request_info.get_post_data() or {}) if request_info else {}
    project_id = (body.get("project_id") or "").strip() or None

    desks: list[dict] = []
    own = await _portal_queue_id(project_id)
    if own:
        desks.append(
            HelpRecipient(kind=HelpRecipientKind.DESK, desk_project_id=own, name="This help desk").model_dump(
                mode="json"
            )
        )
    adopted = await resolve_adopted_helpdesk(project_id) if project_id else None
    if adopted is not None and adopted.queue_project_id != own:
        desks.append(
            HelpRecipient(
                kind=HelpRecipientKind.DESK, desk_project_id=adopted.queue_project_id, name="This project's help desk"
            ).model_dump(mode="json")
        )
    default = await _hub_default_helpdesk()
    reached = await get_info() is not None
    if default is not None and default.project_id not in {d["desk_project_id"] for d in desks}:
        desks.append(
            HelpRecipient(
                kind=HelpRecipientKind.DESK, desk_project_id=default.project_id, name="Flowpad support"
            ).model_dump(mode="json")
        )
    state = "known" if default is not None else ("not_configured" if reached else "unknown")
    return ApiSuccessResponse(data={"desks": desks, "default_state": state})


async def _portal_queue_id(project_id: Optional[str]) -> Optional[str]:
    """The desk queue a portal project IS (its checkout slot is named by the queue id)."""
    if not project_id:
        return None
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.config import is_helpdesk_portal_path  # noqa: PLC0415

    project = await Project.get_by_id(project_id)
    mount = getattr(project, "fs_storage_mount_path", None) if project else None
    if not mount or not is_helpdesk_portal_path(mount):
        return None
    name = Path(mount).name
    queue = name.removeprefix("project-")
    return queue if is_valid_entity_id(queue) else None


@action.post(action_name="help-requests", types=None)
async def help_requests() -> ApiResponse:
    """My help requests, both kinds, one row shape — including ones not delivered yet."""
    request_info = get_current_request_info()
    body = (await request_info.get_post_data() or {}) if request_info else {}
    project_id = (body.get("project_id") or "").strip() or None
    rows: list[dict] = []

    match = {"origin_project_id": project_id} if project_id else {}
    convs = await Conversation.get_all(QueryFilter(match={"kind": ConversationKind.HELPDESK.value, **match}))
    for conv in convs:
        opening = await _opening_message(conv)
        if opening is None:
            continue  # a ticket someone else opened (the desk side), not my request
        rows.append(_request_row(conv, opening, None))

    task_match = {"kind": "vibe", **({"project_id": project_id} if project_id else {})}
    for task in await Task.get_all(QueryFilter(match=task_match)):
        if not task.origin_conversation:
            continue
        conv = await Conversation.get_one({"id": task.origin_conversation})
        opening = await _opening_message(conv) if conv else None
        if conv is None or opening is None:
            continue
        rows.append(_request_row(conv, opening, task))
    return ApiSuccessResponse(data={"requests": rows})


def _request_row(conv: Conversation, opening: FlowMessage, task: Optional[Task]) -> dict:
    status = _request_status(conv, task)
    member = (conv.members or [{}])[0] if task else {}
    return {
        "conversation_id": conv.id,
        "task_id": task.id if task else None,
        "kind": "person" if task else "desk",
        "recipient_label": (member.get("name") or member.get("email") or member.get("user_id"))
        if task
        else "Help desk",
        "title": (task.title if task else conv.title) or "",
        "status": status,
        "delivery": _delivery(opening),
        "delivered": delivery_rank(opening.delivery_status) >= delivery_rank(DeliveryStatus.SENT),
    }


def _request_status(conv: Conversation, task: Optional[Task]) -> str:
    """``open`` | ``resolved`` | ``closed`` — the task decides a person ask, the ticket a desk ask."""
    if task is not None:
        status = str(getattr(task, "status", "") or "").lower()
        if status in ("done", "completed"):
            return "resolved"
        return "closed" if status in ("canceled", "cancelled", "failed") else "open"
    return "resolved" if str(getattr(conv.status, "value", conv.status) or "").lower() == "closed" else "open"
