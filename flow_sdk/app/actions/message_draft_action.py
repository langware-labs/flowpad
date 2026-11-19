"""A conversation's draft: the message being written in its composer, before it is sent.

A draft is a whole ``FlowMessage`` in ``DeliveryStatus.DRAFT`` — its text, files, assets, quote and
thread sit in the message's own fields, so sending it changes its state and nothing else. Two actions:

* ``conversation/<id>/draft`` states the composer's draft as it is now — THE one writer. An empty
  draft is deleted, not kept.
* ``flow_message/<id>/send-draft`` sends a draft (a composer's, or a reply held for review) through
  ``handle_add_message``, the same handler every send takes; the message keeps the draft's id.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Optional

from flow_sdk.actions import action
from flow_sdk.app.actions.flow_message_action import _truthy
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import FILE_VFS_PREFIX, AttachmentType, FlowMessage
from flow_sdk.builtin.user import User
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.schema.data_spec.message_draft_spec import MessageDraftOptions

logger = logging.getLogger(__name__)

#: A draft is read, changed and saved whole; two states of one composer must not interleave.
_WRITING = asyncio.Lock()
#: The drafts being sent right now. A send is long (the hub answers it), so it claims its row rather
#: than hold ``_WRITING``: a second Send of it, or an edit that would write it back as a draft, is refused.
_SENDING: set[str] = set()


def _opt(body: dict, key: str) -> Optional[str]:
    """A body field as a stripped string, None when absent or blank."""
    return str(body.get(key) or "").strip() or None


async def handle_put_draft(conversation_id: str, body: dict, someone_typeid: str) -> ApiResponse:
    """Make the composer's draft what ``body`` says it is: ``text``, ``reply_to_id``, ``thread_root_id``,
    ``asset_references``, ``call`` / ``call_prompt`` / ``task``, ``file_names`` (the files it keeps) and ``files`` (new
    ones). ``thread_id`` names the thread whose composer it is. Answers ``{draft}`` — None when empty."""
    from flow_sdk.app.actions.notification_action import (  # noqa: PLC0415
        _as_list,
        _attach_asset_references,
        _attach_uploaded_files,
        _build_reply_flow_message,
        _json_field,
        _parse_asset_references,
    )
    from flow_sdk.storage import get_entity_embedded_storage  # noqa: PLC0415

    thread_id = _opt(body, "thread_id")
    text = str(body.get("text") or "")
    call_prompt = str(body.get("call_prompt") or "")
    assets = list(dict.fromkeys(_parse_asset_references(body.get("asset_references"))))
    kept = set(map(str, _as_list(_json_field(body.get("file_names") or [], []))))
    uploads = [u for u in _as_list(body.get("files") or []) if hasattr(u, "read")]

    async with _WRITING:
        fm = await FlowMessage.find_composer_draft(conversation_id, thread_id)
        if fm is not None and fm.id in _SENDING:
            return ApiFailResponse(message="This draft is being sent", status_code=409)
        keeps_file = fm is not None and bool(kept.intersection(fm.file_names()))
        if not (text.strip() or call_prompt.strip() or assets or uploads or keeps_file):
            if fm is not None:
                await fm.destroy()  # row, record folder and files: a discarded draft leaves nothing
            return ApiSuccessResponse(data={"draft": None})
        if fm is None:
            if await Conversation.get_one({"id": conversation_id}) is None:
                return ApiFailResponse(message=f"Conversation not found: {conversation_id}", status_code=404)
            sender = await User.current_sender_participant(None)
            fm = _build_reply_flow_message(
                conv_id=conversation_id,
                message=text,
                sender_id=sender.get("user_id") or None,
                sender_name=sender.get("name") or "",
                is_draft=True,
            )
        fm.text = text
        fm.reply_to_id = _opt(body, "reply_to_id")
        fm.thread_root_id = _opt(body, "thread_root_id")
        fm.draft_options = MessageDraftOptions(
            thread_id=thread_id,
            call=_truthy(body.get("call")),
            call_prompt=call_prompt,
            task=_truthy(body.get("task")),
        )

        # The draft's files and assets, as the body states them: a file it no longer keeps is
        # deleted, one uploaded again is replaced, and the assets are restated whole.
        storage = get_entity_embedded_storage(fm.typeid)
        coming = {f"{FILE_VFS_PREFIX}{getattr(u, 'filename', None) or 'file'}" for u in uploads}
        restated = set(fm.asset_typeids())
        attachments = []
        for a in fm.attachment or []:
            data = str(a.data)
            if a.attachment_type == AttachmentType.TYPE_ID and data in restated:
                continue
            if a.attachment_type == AttachmentType.FILE:
                if data in coming:
                    continue
                if data[len(FILE_VFS_PREFIX):] not in kept:
                    Path(storage.get_storage_path(data)).unlink(missing_ok=True)
                    continue
            attachments.append(a)
        fm.attachment = attachments
        await _attach_uploaded_files(fm, uploads)
        await _attach_asset_references(fm, assets)
        fm = await fm.save(someone_typeid)
    return ApiSuccessResponse(data={"draft": fm.model_dump(mode="json")})


async def handle_send_draft(fm_id: str, someone_typeid: str, body: Optional[dict] = None) -> ApiResponse:
    """Send a draft: the same row, through the handler every send takes. ``body`` may name the
    ``reply_to_id`` the send answers now, the ``thread_root_id`` it is written in, whether its text
    goes as a prompt ``call`` (default: as it was drafted) and a ``share_config``."""
    from flow_sdk.app.actions.share_action import add_message_gate  # noqa: PLC0415

    if fm_id in _SENDING:
        return ApiFailResponse(message="This draft is already being sent", status_code=409)
    _SENDING.add(fm_id)
    try:
        async with _WRITING:  # after any edit of it that is under way
            fm = await FlowMessage.get_one({"id": fm_id})
        if not fm:
            return ApiFailResponse(message=f"FlowMessage not found: {fm_id}", status_code=404)
        if not fm.is_draft:
            return ApiFailResponse(message="FlowMessage is not a draft")
        if not fm.conversation_id:
            return ApiFailResponse(message="Draft has no conversation_id")
        refusal, pending_send = add_message_gate({})
        if refusal:
            return ApiFailResponse(message=refusal)
        return await _send(fm, body or {}, someone_typeid, pending_send=pending_send)
    finally:
        _SENDING.discard(fm_id)


async def _send(fm: FlowMessage, body: dict, someone_typeid: str, *, pending_send: bool) -> ApiResponse:
    from flow_sdk.app.actions.notification_action import handle_add_message  # noqa: PLC0415

    options = fm.draft_options or MessageDraftOptions()
    composed = not fm.remote_worker_session_id
    text = (fm.text or "").strip()
    call = _truthy(body["call"]) if "call" in body else options.call
    if not call:
        message, prompt = text, ""
    elif options.call_prompt is None:
        # Stored before the prompt had its own box: the text is the prompt. A draft opened since
        # was restated by the composer (`loadComposerDraft` reads it the same way).
        message, prompt = "", text
    else:
        message, prompt = text, options.call_prompt.strip()
    response = await handle_add_message(
        {
            "conversation_id": fm.conversation_id,
            "message": message,
            "call_prompt": prompt,
            "reply_to_id": _opt(body, "reply_to_id") or fm.reply_to_id,
            "thread_root_id": _opt(body, "thread_root_id") or fm.thread_root_id,
            # A held reply's attachments are its session's, already checked when it was written.
            "asset_references": fm.asset_typeids() if composed else [],
            "remote_worker_session_id": fm.remote_worker_session_id,
            "share_config": body.get("share_config") or body.get("shareConfig") or {},
        },
        someone_typeid,
        pending_send=pending_send,
        draft=fm,
    )
    if not isinstance(response, ApiSuccessResponse) or composed:
        return response

    # A drafted STARTING prompt sat at DRAFT on the sender's session row; sending it is the request for access.
    from flow_sdk.builtin.remote_worker_session import (  # noqa: PLC0415
        RemoteWorkerSession,
        RemoteWorkerSessionStatus,
    )

    session = await RemoteWorkerSession.resolve_state(fm.remote_worker_session_id)
    if session is not None and session.status == RemoteWorkerSessionStatus.DRAFT:
        session.mark_activity(RemoteWorkerSessionStatus.PENDING)
        await session.save(someone_typeid)
    return response


@action.post(action_name="draft", types=[BuiltinEntityType.CONVERSATION.value])
async def put_draft() -> ApiResponse:
    """``POST /graph/conversation/<id>/draft`` — the composer's draft, as it is now."""
    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        return ApiFailResponse(message="No request info found")
    if not request_info.someone_typeid:
        return ApiFailResponse(message="Authentication required")
    body = await request_info.get_post_data() or {}
    return await handle_put_draft(str(request_info.target_entity_typeid.id), body, request_info.someone_typeid)


@action.post(action_name="send-draft", types=[BuiltinEntityType.FLOW_MESSAGE.value])
async def send_draft() -> ApiResponse:
    """``POST /graph/flow_message/<id>/send-draft`` — send a draft; the message keeps its id."""
    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        return ApiFailResponse(message="No request info found")
    if not request_info.someone_typeid:
        return ApiFailResponse(message="Authentication required")
    try:
        body = await request_info.get_post_data() or {}
    except ValueError:
        body = {}
    return await handle_send_draft(str(request_info.target_entity_typeid.id), request_info.someone_typeid, body)
