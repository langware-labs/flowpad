"""Action handlers for conversation messaging and a few notification utilities.

The primary surface is ``handle_add_message`` — the single message-send handler
behind the ``conversation/<id>/add_message`` action (see ``share_action.py``).
It builds the FlowMessage, persists it locally, links it on the hub via
``Conversation.add_message`` (so delivery receipts work), and uploads any
attachment body in a background task.

The legacy ``share_task`` / ``conversation-start-bundle`` / hub
``flow_message/send`` family of actions used to live here; all three dialogs
that called them now go through the conversation transport (see
``ts_sdk/src/entities/notifications.ts#sendReply``), so the legacy code has
been removed.

Routes:
  POST /api/v1/graph/notification/{id}/refresh
  GET  /api/v1/graph/notification/{id}/open
"""

from __future__ import annotations

import asyncio
import json as _json
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

from flow_sdk.actions.action_registry import action
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.user import User

if TYPE_CHECKING:
    from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.cli.auth.hub_login import is_logged_in
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.discovery.notify import send_resource_sync
from flow_sdk.fs_store import SyncOperation
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.utils.git import (
    find_project_root,
    git_pull,
)
from flow_sdk.utils.hub import hub_get

logger = logging.getLogger(__name__)

PLACEHOLDER_FOR_EMPTY_MESSAGE_WITH_PROMPT = "Please run the following prompt:"




def _build_reply_flow_message(
    *,
    conv_id: str,
    message: str,
    sender_id: Optional[str],
    sender_name: str,
    is_draft: bool = False,
    shared_context_entities: Optional[list[str]] = None,
) -> "FlowMessage":
    """Build (but do not save) the FlowMessage entity for a conversation reply.

    The caller is responsible for attaching any uploaded files and then saving.
    """
    from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage

    context: list = [TypeId(type=BuiltinEntityType.CONVERSATION.value, id=conv_id)]
    if shared_context_entities:
        seen = {str(ce) for ce in context}
        for raw in shared_context_entities:
            s = (raw or "").strip()
            if not s or s in seen:
                continue
            try:
                context.append(TypeId(s))
                seen.add(s)
            except ValueError:
                continue

    reply_fm = FlowMessage.model_validate({
        "text": message,
        "shared_context_entities": [str(c) if not isinstance(c, str) else c for c in context],
        "attachment": [],
        "sender_id": sender_id,
        "sender_name": sender_name,
        "conversation_id": conv_id,
        "is_draft": is_draft,
    })
    reply_fm.id = FlowMessage.allocate_id(reply_fm.model_dump())
    reply_fm.attachment = [
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.CONVERSATION.value, id=conv_id))),
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.FLOW_MESSAGE.value, id=reply_fm.id))),
    ]
    return reply_fm


async def _attach_prompt(
    reply_fm: "FlowMessage",
    proposer_id: Optional[str],
    prompt_text: str,
    prompt_files: list,
) -> None:
    """Append a PROMPT attachment to the FlowMessage.

    `prompt_text` (if non-empty) is stored inline in `data`. Each file in
    `prompt_files` is written to the entity VFS at `prompt/{filename}` and
    appended as a separate PROMPT attachment whose `data` is that VFS subpath.
    """
    from flow_sdk.builtin.flow_message import PROMPT_FILE_VFS_PREFIX, Attachment, AttachmentType
    from flow_sdk.storage import get_entity_embedded_storage

    new_atts: list = list(reply_fm.attachment or [])
    if prompt_text:
        new_atts.append(Attachment(
            attachment_type=AttachmentType.PROMPT,
            data=prompt_text,
            proposer_id=proposer_id,
        ))
    if prompt_files:
        storage = get_entity_embedded_storage(reply_fm.typeid)
        for uf in prompt_files:
            if not hasattr(uf, "read"):
                continue
            filename = getattr(uf, "filename", None) or "prompt.txt"
            vfs_subpath = f"{PROMPT_FILE_VFS_PREFIX}{filename}"
            local_path = Path(storage.get_storage_path(vfs_subpath))
            local_path.parent.mkdir(parents=True, exist_ok=True)
            local_path.write_bytes(await uf.read())
            new_atts.append(Attachment(
                attachment_type=AttachmentType.PROMPT,
                data=vfs_subpath,
                proposer_id=proposer_id,
            ))
    reply_fm.attachment = new_atts


async def _attach_uploaded_files(reply_fm: "FlowMessage", uploaded_files: list) -> None:
    """Save uploaded files into the FlowMessage entity's VFS storage and append FILE attachments.

    Files are stored at data/{filename} within the entity's embedded storage root so they can
    be served via GET /api/v1/graph/flow_message/{id}/fs/download/data/{filename}.
    """
    from flow_sdk.builtin.flow_message import FILE_VFS_PREFIX, Attachment, AttachmentType
    from flow_sdk.storage import get_entity_embedded_storage

    fm_typeid = reply_fm.typeid
    storage = get_entity_embedded_storage(fm_typeid)
    new_attachments: list = list(reply_fm.attachment or [])
    added_any = False
    for uf in uploaded_files:
        if not hasattr(uf, "read"):
            continue
        filename = getattr(uf, "filename", None) or "file"
        vfs_subpath = f"{FILE_VFS_PREFIX}{filename}"
        local_path = Path(storage.get_storage_path(vfs_subpath))
        local_path.parent.mkdir(parents=True, exist_ok=True)
        content = await uf.read()
        local_path.write_bytes(content)
        new_attachments.append(Attachment(attachment_type=AttachmentType.FILE, data=vfs_subpath))
        added_any = True
    if added_any:
        # Assign (not append) so __setattr__ runs and _dirty is set — required because
        # for the original-send path the entity has already been saved once and
        # in-place list mutation doesn't reach the entity's dirty flag.
        reply_fm.attachment = new_attachments


def _parse_asset_references(raw: Any) -> list:
    """Normalize ``asset_references`` body field into a list of typeid strings.

    Multipart bodies arrive as a JSON-encoded string (``sendReply`` does
    ``form.append('asset_references', JSON.stringify([...]))``); JSON bodies
    arrive as an already-decoded list. A scalar string is wrapped in a list.
    """
    import json

    if raw is None:
        return []
    if isinstance(raw, list):
        return [str(x) for x in raw if isinstance(x, (str, bytes))]
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", errors="replace")
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return []
        try:
            parsed = json.loads(s)
        except json.JSONDecodeError:
            return [s]
        if isinstance(parsed, list):
            return [str(x) for x in parsed if isinstance(x, (str, bytes))]
        if isinstance(parsed, str):
            return [parsed]
        return []
    return []


async def _attach_asset_references(reply_fm: "FlowMessage", asset_typeids: list) -> None:
    """Append TYPE_ID attachments for each asset typeid string on the FlowMessage.

    Mirrors ``_attach_uploaded_files`` for assets — the typeid is stored verbatim
    in ``Attachment.data`` so downstream readers can resolve it via TypeId(...).
    """
    from flow_sdk.builtin.flow_message import Attachment, AttachmentType

    new_attachments: list = list(reply_fm.attachment or [])
    added_any = False
    for tid in asset_typeids:
        if not isinstance(tid, str) or not tid.strip():
            continue
        new_attachments.append(Attachment(attachment_type=AttachmentType.TYPE_ID, data=tid.strip()))
        added_any = True
    if added_any:
        reply_fm.attachment = new_attachments


async def _append_message_to_conversation(
    *,
    conv: Conversation,
    fm_id: str,
    someone_typeid: str,
) -> Conversation:
    """Append a Pointer to conversation.jsonl via the unified write path.

    The FlowMessage row is already saved by the caller (reply send flow); this
    helper only needs to append the pointer + project. We funnel through
    ``materialize_flow_message`` so the WS sequencing (FM CREATE then
    Conversation UPDATE) matches every other producer; the FM upsert is a
    no-op since the row already exists with this id.
    """
    from flow_sdk.app.actions.materialize_flow_message import materialize_flow_message
    from flow_sdk.builtin.flow_message import FlowMessage

    fm = await FlowMessage.get_one({"id": fm_id})
    payload = fm.model_dump() if fm else {"id": fm_id, "text": ""}
    await materialize_flow_message(
        payload,
        conversation_id=conv.id,
        someone_typeid=someone_typeid,
    )
    return await Conversation.get_one({"id": conv.id})


# Types that ride along every message as transport plumbing — never treated as
# shared context to merge onto the conversation.
_NON_CONTEXT_TYPES = {"conversation", "flow_message"}


def _parse_context_typeids(
    conv: Conversation,
    asset_references: list,
    shared_context_entities: list,
) -> list[TypeId]:
    """Union of asset_references + shared_context_entities, parsed to TypeIds,
    excluding the conversation's own id and the transport types. Deduped,
    order-preserving."""
    seen: set[str] = set()
    out: list[TypeId] = []
    for raw in [*(asset_references or []), *(shared_context_entities or [])]:
        if not raw:
            continue
        try:
            tid = raw if isinstance(raw, TypeId) else TypeId(str(raw))
        except (ValueError, TypeError):
            continue
        if tid.type in _NON_CONTEXT_TYPES or not tid.id:
            continue
        if tid.id == conv.id:
            continue
        key = str(tid)
        if key in seen:
            continue
        seen.add(key)
        out.append(tid)
    return out


async def _merge_shared_context_into_conversation(
    conv: Conversation,
    typeids: list[TypeId],
    someone_typeid: str,
) -> None:
    """Append the just-shared items to ``conv.shared_context_entities`` and link
    each item back to the conversation (parent_type_id). Idempotent — a re-share
    of the same item is a no-op (dedup by (type, id)). Best-effort: never blocks
    the message send."""
    if not typeids:
        return
    try:
        changed = conv.add_shared_context_entities(*typeids)
        if changed:
            await conv.save(someone_typeid)
        await conv._link_context_to_conversation(typeids, someone_typeid=someone_typeid)
    except Exception as e:  # noqa: BLE001
        logger.warning(
            "[append_conversation] merge shared context failed (non-fatal): %s", e, exc_info=True
        )


async def _ensure_claude_session_rows(typeids: list[TypeId]) -> None:
    """Sender-side ensure for shared ClaudeTranscript refs.

    A ``claude_session`` row only exists after an indexer walk (walks are
    explicit-click only), so the session being shared often has no row yet —
    which would leave the chip unresolvable and the context links dangling.
    The share IS an explicit user action on exactly this session, so locate
    its JSONL and run the scoped single-file index. Best-effort."""
    from flow_sdk.builtin.claude_session import ClaudeSession  # noqa: PLC0415
    from flow_sdk.fs_store.indexer.functions.claude_sessions import get_claude_session  # noqa: PLC0415
    from flow_sdk.fs_store.transcript_indexer.handlers.single_file_indexers import (  # noqa: PLC0415
        _index_single_claude_session,
    )

    for tid in typeids:
        if tid.type != BuiltinEntityType.CLAUDE_SESSION.value:
            continue
        try:
            if await ClaudeSession.get_one({"id": tid.id}) is not None:
                continue
            rec = get_claude_session(tid.id)
            if rec is None or rec.asset_ref is None:
                continue
            await _index_single_claude_session(Path(rec.asset_ref.path))
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "[append_conversation] ensure claude_session %s failed (non-fatal): %s",
                tid, e, exc_info=True,
            )


async def _link_message_into_context_entities(
    reply_fm: "FlowMessage",
    typeids: list[TypeId],
    someone_typeid: str,
) -> None:
    """Mutual context: each just-shared context entity learns about this
    message (``flow_message-<id>`` lands in its ``shared_context_entities``);
    the message side already rides on ``reply_fm.shared_context_entities`` —
    e.g. an AgenticProcess and the FlowMessage that shared its transcript end
    up referencing each other. Idempotent (dedup by (type, id)); best-effort
    per entity — never blocks the send."""
    if not typeids:
        return
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    fm_tid = TypeId(f"{BuiltinEntityType.FLOW_MESSAGE.value}-{reply_fm.id}")
    for tid in typeids:
        try:
            cls = SchemaRegistry.get_entity_cls(tid.type)
            if cls is None:
                continue
            ent = await cls.get_one({"id": tid.id})
            if ent is None:
                continue
            if ent.add_shared_context_entities(fm_tid):
                await ent.save(someone_typeid)
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "[append_conversation] context backlink %s ← %s failed (non-fatal): %s",
                tid, fm_tid, e, exc_info=True,
            )


async def _send_conversation_message_header(conv: "Conversation", reply_fm: "FlowMessage") -> bool:
    """Create the hub-side FlowMessage header via the conversation's
    ``add_message`` action.

    Returns ``True`` on confirmed hub-side creation, ``False`` if the call
    failed (network blip, hub rejection, etc.). Callers that gate later
    state on hub success (e.g. flipping ``fm.remote = True``) MUST check
    the return value — a swallowed exception is no longer a silent success.

    Unlike the legacy ``flow_message/send`` path, ``add_message`` runs
    ``Conversation.add_child`` on the hub, so the FlowMessage is graph-linked
    to its parent Conversation. Delivery receipts (``_bump_delivery_status``)
    resolve that parent via ``get_ancestor`` — without the link they skip with
    ``no_parent_conversation`` and the sender's checkmarks never advance. The
    FM id is pinned to the local id so the body bundle uploaded next lands
    under the same key.
    """
    try:
        attachments = [a.model_dump(mode="python") for a in (reply_fm.attachment or [])]
        shared_context_entities = [str(c) for c in (reply_fm.shared_context_entities or [])]
        await conv.add_message(
            reply_fm.text,
            sender_name=reply_fm.sender_name or None,
            sender_id=reply_fm.sender_id or None,
            flow_message_id=reply_fm.id,
            attachments=attachments or None,
            shared_context_entities=shared_context_entities or None,
        )
        return True
    except Exception as e:  # noqa: BLE001
        logger.warning(
            "[append_conversation] hub add_message header failed (non-fatal): %s", e, exc_info=True
        )
        return False


async def _upload_body_and_finalize(reply_fm: "FlowMessage", conv_id: str) -> None:
    """Pack + upload the FlowMessage body bundle in a background task.

    ``upload_body`` runs the hub PUT → fs/upload → set_body_status sequence,
    flipping the hub-side body_status to READY (which fans the UPDATE to
    receivers). This mirrors READY onto the local FM and refreshes the UI so
    the sender's attachment chips unlock. On failure the body stays UPLOADING
    and the manual ``upload_body`` action remains available for retry.
    """
    try:
        from flow_sdk.core.network.resource_tracker import (  # noqa: PLC0415
            make_flow_message_progress_emitter,
        )
        await reply_fm.upload_body(
            on_progress=make_flow_message_progress_emitter(reply_fm.id, "upload"),
        )
        await reply_fm.save()
        _notify_ui_conversation_updated(conv_id, "", reply_fm.id)
    except Exception as e:  # noqa: BLE001
        logger.warning(
            "[append_conversation] background body upload failed (non-fatal): %s", e, exc_info=True
        )


async def _hub_knows_conversation(conv_id: str) -> bool:
    """Quick HTTP probe to decide whether the hub knows this conversation."""
    try:
        import httpx

        from flow_sdk.cli.auth.credentials import load_credentials
        from flow_sdk.cloud_client.client import ApiConfig

        creds = load_credentials()
        if not creds or not creds.api_key:
            return False
        api = ApiConfig.from_env()
        url = api._get_full_url(f"/graph/conversation/{conv_id}")
        headers = {"Authorization": f"Bearer {creds.api_key}", "Accept": "application/json"}
        async with httpx.AsyncClient(timeout=3.0) as h:
            r = await h.get(url, headers=headers)
            if r.status_code != 200:
                return False
            body = r.json()
            return (body or {}).get("status") == "SUCCESS" and bool((body or {}).get("data"))
    except Exception:
        return False


async def _try_send_reply_via_hub(
    *,
    conv_id: str,
    text: str,
    sender_name: str,
    sender_id: Optional[str],
    someone_typeid: str,
) -> Optional[ApiResponse]:
    """If ``conv_id`` is a hub-mirrored conversation, push the reply through
    the hub bridge so the other party gets it via their own bridge. Returns
    the API response on success, ``None`` to fall through to local-only.
    """
    try:
        from flow_sdk.cloud_client.hub_bridge import hub_ws_bridge
        from flow_sdk.cloud_client.ws_client import hub_ws_manager
    except Exception:
        return None

    if not hub_ws_manager.is_connected:
        return None

    if not hub_ws_bridge.is_hub_conversation(conv_id):
        # Bridge hasn't seen an inbound event for this conv this session
        # (e.g., it landed on a previous run and the in-memory set didn't
        # survive restart). Probe the hub directly — if the hub knows the
        # conv, treat it as hub-mirrored and remember for the rest of this
        # session.
        if not await _hub_knows_conversation(conv_id):
            return None
        hub_ws_bridge.remember_hub_conversation(conv_id)

    try:
        resp = await hub_ws_bridge.add_message(
            conversation_id=conv_id,
            text=text,
            sender_name=sender_name or None,
        )
    except Exception as e:
        logger.warning("[append_conversation] hub add_message failed: %s", e, exc_info=True)
        return None

    fm_payload = (resp or {}).get("data") or {}
    hub_fm_id = fm_payload.get("id")
    if not hub_fm_id:
        logger.warning("[append_conversation] hub add_message returned no id; falling through")
        return None

    # Materialize the hub-confirmed message into the local store. Sender side
    # only — hub fanout skips the sender, so this is the local UI's source of
    # truth for this row.
    try:
        from flow_sdk.app.actions.materialize_flow_message import materialize_flow_message

        payload = dict(fm_payload)
        payload["id"] = hub_fm_id
        payload["text"] = text
        if sender_id and not payload.get("sender_id"):
            payload["sender_id"] = sender_id
        if sender_name and not payload.get("sender_name"):
            payload["sender_name"] = sender_name
        await materialize_flow_message(
            payload,
            conversation_id=conv_id,
            someone_typeid=someone_typeid,
            notify=True,
            # Hub confirmed this send (add_message returned its id); the local
            # row mirrors a hub counterpart.
            remote=True,
        )
    except Exception as e:
        logger.warning("[append_conversation] hub-side reply materialize failed: %s", e, exc_info=True)
        # Hub got the message; local UI will pick it up on the next refetch.

    conv_after = await Conversation.get_one({"id": conv_id})
    message_count = conv_after.message_count if conv_after else 0
    _notify_ui_conversation_updated(conv_id, "", hub_fm_id)
    return ApiSuccessResponse(data={
        "task_id": "",
        "conversation_id": conv_id,
        "message_count": message_count,
        "flow_message_id": hub_fm_id,
    })


def _notify_ui_conversation_updated(conv_id: str, task_id: str, fm_id: str) -> None:
    """Fire-and-forget sniffer EVENT so the UI refreshes the conversation panel.

    Must be SyncOperation.EVENT — never CRUD. Sent as UPDATE it reached the
    webhook receiver's ``_reflect_entity``, which loaded the Conversation
    entity *while ``materialize_flow_message`` was still mid-flight* (before
    the new pointer was projected into ``message_ids``), re-saved that stale
    snapshot, and re-broadcast ``notify_updated()`` — clobbering the freshly
    projected message list and leaving the UI exactly one message behind.
    EVENT routes to the event handler / sniffer instead, which is all this
    channel was ever for. Mirrors ``materialize_flow_message``'s own
    ``conversation_updated`` event.
    """
    try:
        send_resource_sync(
            type="conversation",
            id=conv_id,
            operation=SyncOperation.EVENT,
            data={
                "event_name": "conversation_updated",
                "event_data": {"conversation_id": conv_id, "task_id": task_id, "flow_message_id": fm_id},
            },
        )
    except Exception:
        pass


async def handle_add_message(body: dict, someone_typeid: str) -> ApiResponse:
    """Append a message to a Conversation — the single message-send handler.

    Exposed as the `conversation/<id>/add_message` action. Handles text-only
    sends and attachment sends (files, images, prompts, asset references)
    alike. Requires `conversation_id` (project-scoped conversation path); any
    Task is attached via context_entities, not a separate code path.
    """
    conversation_id = (body.get("conversation_id") or "").strip()
    message = (body.get("message") or "").strip()
    is_draft = bool(body.get("is_draft"))
    prompt_text_preview = (body.get("prompt_text") or "").strip()
    prompt_files_preview = body.get("prompt_files") or []
    if not isinstance(prompt_files_preview, list):
        prompt_files_preview = [prompt_files_preview]
    uploaded_files_preview = body.get("files") or []
    if not isinstance(uploaded_files_preview, list):
        uploaded_files_preview = [uploaded_files_preview]
    asset_references = _parse_asset_references(body.get("asset_references"))
    # Accept both the new ``shared_context_entities`` name and the legacy
    # ``context_entities`` body key during transition (frontend may not be
    # fully cut over yet). Treat both as wire-bound (shared).
    shared_context_entities = (
        body.get("shared_context_entities")
        or body.get("context_entities")
        or []
    )
    if isinstance(shared_context_entities, str):
        shared_context_entities = [shared_context_entities]
    elif not isinstance(shared_context_entities, list):
        shared_context_entities = []

    if not conversation_id:
        return ApiFailResponse(message="conversation_id is required")
    if (
        not message
        and not prompt_text_preview
        and not prompt_files_preview
        and not uploaded_files_preview
        and not asset_references
    ):
        return ApiFailResponse(message="message, prompt, files, or asset_references required")
    if not message:
        # Synthesize a placeholder so the rest of the pipeline (which assumes a
        # non-empty text body) keeps working for prompt-only / files-only sends.
        # The frontend suppresses the body when it matches this exact constant.
        message = PLACEHOLDER_FOR_EMPTY_MESSAGE_WITH_PROMPT

    conv = await Conversation.get_one({"id": conversation_id})
    if not conv:
        return ApiFailResponse(message=f"Conversation not found: {conversation_id}")

    # Merge the items being shared into THIS conversation's context (both the
    # conversation row and the items themselves), so a re-share into an existing
    # conversation updates context just like the new-conversation path does —
    # without minting a new conversation/invitation. The local backend is the
    # single writer of the local Conversation (shared_context_entities is a
    # local-only field; the hub has no such concept), so this lives here, not
    # in an optimistic FE write. Skip the conversation's own typeid and the
    # transport types (conversation/flow_message) that ride every message.
    context_typeids = _parse_context_typeids(conv, asset_references, shared_context_entities)
    # Shared ClaudeTranscripts may not be indexed yet — materialize their rows
    # first so the merge/backlink below (and the chip's name lookup) resolve.
    await _ensure_claude_session_rows(context_typeids)
    await _merge_shared_context_into_conversation(conv, context_typeids, someone_typeid)

    sender_participant = await User.current_sender_participant(body.get("sender_name"))
    sender_id = sender_participant.get("user_id") or None
    sender_name = sender_participant.get("name") or ""

    uploaded_files = body.get("files") or []
    if not isinstance(uploaded_files, list):
        uploaded_files = [uploaded_files]
    prompt_text = (body.get("prompt_text") or "").strip()
    prompt_files = body.get("prompt_files") or []
    if not isinstance(prompt_files, list):
        prompt_files = [prompt_files]

    # Text-only WS fast path. The hub handles fan-out + delivery receipts, then
    # we materialize the hub-confirmed FM locally for the sender's UI.
    if (
        not is_draft
        and not uploaded_files
        and not prompt_text
        and not prompt_files
        and not asset_references
    ):
        hub_response = await _try_send_reply_via_hub(
            conv_id=conv.id,
            text=message,
            sender_name=sender_name,
            sender_id=sender_id,
            someone_typeid=someone_typeid,
        )
        if hub_response is not None:
            return hub_response

    reply_fm = _build_reply_flow_message(
        conv_id=conv.id,
        message=message,
        sender_id=sender_id,
        sender_name=sender_name,
        is_draft=is_draft,
        shared_context_entities=shared_context_entities,
    )

    if uploaded_files:
        await _attach_uploaded_files(reply_fm, uploaded_files)

    if asset_references:
        await _attach_asset_references(reply_fm, asset_references)

    if prompt_text or prompt_files:
        await _attach_prompt(reply_fm, sender_id, prompt_text, prompt_files)

    # A conversation reply goes to the hub whenever it's hub-mirrored
    # (``conv.remote`` is the load-bearing signal). Local-only conversations
    # keep body_status=NA — the attachment is served off local VFS.
    is_remote_send = is_logged_in() and bool(getattr(conv, "remote", False))
    if is_remote_send and reply_fm.has_body():
        from flow_sdk.builtin.flow_message import BodyStatus  # noqa: PLC0415
        reply_fm.body_status = BodyStatus.UPLOADING

    reply_fm = await reply_fm.save(someone_typeid)

    if is_draft:
        # Local-only draft: skip jsonl append and hub push.
        # The UI surfaces the draft via an entity query on (conversation_id, is_draft=true).
        return ApiSuccessResponse(data={
            "conversation_id": conv.id,
            "message_count": conv.message_count,
            "flow_message_id": reply_fm.id,
            "is_draft": True,
        })

    # Mutual context: link each just-shared entity back to this message (the
    # message → entity direction already rides on the FM's own
    # shared_context_entities, stamped at build time above).
    await _link_message_into_context_entities(reply_fm, context_typeids, someone_typeid)

    # Append pointer + project message_ids before the hub header so the
    # conversation.jsonl is consistent when the body bundle packs.
    conv = await _append_message_to_conversation(
        conv=conv,
        fm_id=reply_fm.id,
        someone_typeid=someone_typeid,
    )

    # Refresh the sender's UI immediately, then create the hub-side header via
    # add_message (graph-linked to the parent Conversation so delivery receipts
    # work). The body bundle uploads in a background task.
    _notify_ui_conversation_updated(conv.id, "", reply_fm.id)
    if is_remote_send:
        await _send_conversation_message_header(conv, reply_fm)
        from flow_sdk.builtin.flow_message import BodyStatus  # noqa: PLC0415
        if reply_fm.body_status == BodyStatus.UPLOADING:
            asyncio.create_task(_upload_body_and_finalize(reply_fm, conv.id))

    return ApiSuccessResponse(data={
        "conversation_id": conv.id,
        "message_count": conv.message_count,
        "flow_message_id": reply_fm.id,
    })


async def handle_refresh_notifications(project_path: str) -> ApiResponse:
    """Git pull the project repo and run the incoming notification scanner."""
    import asyncio as _asyncio
    project_root = find_project_root(project_path) if project_path else None
    if project_root:
        await git_pull(project_root)
    try:
        from flow_sdk.app.actions.notification_scanner import scan_incoming_notifications
        local_user = await User.get_one({"uname": "local"})
        if local_user:
            await _asyncio.ensure_future(scan_incoming_notifications(local_user.id))
    except Exception as e:
        logger.warning(f"[notification_action] scan error (non-fatal): {e}")
    return ApiSuccessResponse(data={"refreshed": True})


@action.post(action_name="refresh", types=["notification"])
async def refresh_notifications() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info:
            return ApiFailResponse(message="No request info found")
        body = await request_info.get_post_data() or {}
        return await handle_refresh_notifications(
            project_path=(body.get("project_path") or "").strip(),
        )
    except Exception as e:
        logger.error(f"[notification_action] refresh error: {e}", exc_info=True)
        return ApiFailResponse(message=f"Failed to refresh: {str(e)}")


@action.post(action_name="update-local-user-name", types=None)
async def update_local_user_name() -> ApiResponse:
    """Update the local user's display name and mark it as manually overridden.

    The override label tells bootstrap not to clobber this name from
    `git config user.name` on future server starts.
    """
    from flow_sdk.server.routes.bootstrap import NAME_OVERRIDE_LABEL

    request_info = get_current_request_info()
    if not request_info:
        return ApiFailResponse(message="No request info found")
    body = await request_info.get_post_data() or {}
    new_name = (body.get("name") or "").strip()
    if not new_name:
        return ApiFailResponse(message="name is required")
    local_user = await User.get_one({"uname": "local"})
    if not local_user:
        return ApiFailResponse(message="Local user not found")
    local_user.name = new_name
    if NAME_OVERRIDE_LABEL not in (local_user.labels or []):
        local_user.add_label(NAME_OVERRIDE_LABEL)
    await local_user.save()
    return ApiSuccessResponse(data={"name": new_name})


# ────────────────────────────────────────────────────────────────────────────
# Project mapping (per-machine: remote_project_id → local_project_id)
# Stored as a JSON file under InstanceSettings.flow_home so the mapping
# survives restarts and is independent of the User entity (which has no
# settings field today).
# ────────────────────────────────────────────────────────────────────────────


def _project_mapping_path() -> Path:
    from flow_sdk.instance_settings import get_instance_settings
    return get_instance_settings().flow_home / "project_mapping.json"


def _load_project_mapping() -> dict:
    p = _project_mapping_path()
    if not p.exists():
        return {}
    try:
        return _json.loads(p.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}


def _save_project_mapping(mapping: dict) -> None:
    p = _project_mapping_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(_json.dumps(mapping, indent=2), encoding="utf-8")


@action.get(action_name="get-project-mapping", types=None)
async def get_project_mapping() -> ApiResponse:
    """Return the per-machine remote→local project mapping dict."""
    return ApiSuccessResponse(data={"mapping": _load_project_mapping()})


@action.post(action_name="set-project-mapping", types=None)
async def set_project_mapping() -> ApiResponse:
    """Set the local project that a remote project_id maps to.

    Body: { remote_project_id: str, local_project_id: str }
    The mapping is keyed by remote_project_id; subsequent messages bound to
    the same remote project route silently to the chosen local project.
    """
    request_info = get_current_request_info()
    if not request_info:
        return ApiFailResponse(message="No request info found")
    body = await request_info.get_post_data() or {}
    remote_id = (body.get("remote_project_id") or "").strip()
    local_id = (body.get("local_project_id") or "").strip()
    if not remote_id or not local_id:
        return ApiFailResponse(message="remote_project_id and local_project_id are required")
    mapping = _load_project_mapping()
    mapping[remote_id] = local_id
    _save_project_mapping(mapping)
    return ApiSuccessResponse(data={"mapping": mapping})


# ────────────────────────────────────────────────────────────────────────────
# PROMPT attachment lifecycle
# ────────────────────────────────────────────────────────────────────────────


@action.post(action_name="approve-prompt", types=["flow_message"])
async def approve_prompt() -> ApiResponse:
    """Mark PROMPT attachments on a FlowMessage as approved by the current user.

    The frontend then runs the prompt in a forked Claude session.
    Body: { attachment_index?: number, approve_all?: bool }
      - With approve_all=True (default for the conversation flow): every PROMPT
        attachment on the message flips to approved in one shot, so the typed
        text and any attached prompt files all execute as a single Claude turn.
      - Without approve_all: only the targeted attachment_index (or the first
        unapproved PROMPT) is approved.
    """
    from flow_sdk.builtin.flow_message import AttachmentType
    from flow_sdk.builtin.flow_message import FlowMessage as FM

    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        return ApiFailResponse(message="No request info found")
    fm_id = str(request_info.target_entity_typeid.id)
    fm = await FM.get_one({"id": fm_id})
    if not fm:
        return ApiFailResponse(message=f"FlowMessage not found: {fm_id}")

    body = await request_info.get_post_data() or {}
    idx = body.get("attachment_index")
    approve_all = bool(body.get("approve_all"))
    local_user = await User.get_one({"uname": "local"})
    approver_id = local_user.id if local_user else None

    new_atts = list(fm.attachment or [])

    if approve_all:
        approved_indices: list[int] = []
        for i, a in enumerate(new_atts):
            if a.attachment_type == AttachmentType.PROMPT and not a.approved_by:
                new_atts[i] = a.model_copy(update={"approved_by": approver_id})
                approved_indices.append(i)
        if not approved_indices:
            return ApiFailResponse(message="No unapproved PROMPT attachment found on this message")
        fm.attachment = new_atts
        await fm.save(request_info.someone_typeid or "")
        return ApiSuccessResponse(data={"attachment_indices": approved_indices, "approved_by": approver_id})

    target_idx: Optional[int] = None
    if isinstance(idx, int) and 0 <= idx < len(new_atts):
        if new_atts[idx].attachment_type == AttachmentType.PROMPT:
            target_idx = idx
    if target_idx is None:
        for i, a in enumerate(new_atts):
            if a.attachment_type == AttachmentType.PROMPT and not a.approved_by:
                target_idx = i
                break
    if target_idx is None:
        return ApiFailResponse(message="No unapproved PROMPT attachment found on this message")

    new_atts[target_idx] = new_atts[target_idx].model_copy(update={"approved_by": approver_id})
    fm.attachment = new_atts
    await fm.save(request_info.someone_typeid or "")
    return ApiSuccessResponse(data={"attachment_index": target_idx, "approved_by": approver_id})


@action.get(action_name="open", types=["notification"])
async def open_notification() -> ApiResponse:
    """Deep-link handler: fetch notification from hub, redirect to UI dialog."""
    from flow_sdk.server.routes.notify import handle_notification_deep_link

    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        return ApiFailResponse(message="No request info found", status_code=400)

    notification_id = str(request_info.target_entity_typeid.id)
    data = await hub_get(BuiltinEntityType.NOTIFICATION, notification_id)

    meta = data.get("metadata") or {} if data else {}
    # Notification.id is the same as the hub FlowMessage id (set in
    # _save_local_notification), so we use notification_id as fm_id.
    return await handle_notification_deep_link(
        fm_id=notification_id,
        task_id=(meta.get("task_id") or (data or {}).get("task_id") or "").strip(),
        project_url=(meta.get("project_url") or (data or {}).get("project_url") or "").strip(),
        branch=(meta.get("branch") or (data or {}).get("branch") or "").strip(),
        repo_id=(meta.get("repo_id") or (data or {}).get("repo_id") or "").strip(),
        sender_name=(meta.get("sender_name") or (data or {}).get("sender_name") or "").strip(),
        title=(meta.get("task_title") or (data or {}).get("task_title") or "").strip(),
    )
