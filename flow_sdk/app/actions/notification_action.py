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
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

from flow_sdk.actions.action_registry import action
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.user import User

if TYPE_CHECKING:
    from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.cli.auth.hub_login import is_logged_in
from flow_sdk.core.entity.parent_share import collect_parent_share_typeids
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


def _prompt_file_is_image_or_binary(filename: str, raw: bytes) -> bool:
    """True when an uploaded prompt 'file' must be kept as raw bytes rather than
    minted into a text ``Prompt`` entity — an image (by extension) or any binary
    blob (NUL bytes). Such files become prompt-file attachments the UI renders
    inline, never decoded as text."""
    from flow_sdk.builtin.flow_message import is_image_filename  # noqa: PLC0415
    from flow_sdk.llm_index.diff import is_binary_bytes  # noqa: PLC0415

    if is_image_filename(filename):
        return True
    return is_binary_bytes(bytes(raw))


def _fm_response_fields(fm: "FlowMessage", conv: "Conversation") -> dict:
    """The add_message response payload for a FlowMessage.

    The SDK constructs a FlowMessage straight from this data, and the base
    entity MINTS A RANDOM id when none is present (APIEntity:
    ``this.id = entityJson.id || uuidv4()``) — silently detaching the client
    object from the real row. Always carry the FM's own fields; ``model_dump``
    handles enum/Attachment serialization uniformly.
    """
    dumped = fm.model_dump(mode="json")
    return {
        "id": fm.id,
        "body_status": dumped.get("body_status"),
        "delivery_status": dumped.get("delivery_status"),
        "sender_id": dumped.get("sender_id"),
        "sender_name": dumped.get("sender_name"),
        "attachment": dumped.get("attachment") or [],
        # Session fields ride the response too: the client renders the sent
        # message from THIS object, and a prompt's session card keys on them —
        # without them the card waited for the next entity refetch.
        "remote_worker_session_id": dumped.get("remote_worker_session_id"),
        "kind": dumped.get("kind"),
        "is_draft": bool(dumped.get("is_draft")),
        "conversation_id": conv.id,
        "message_count": conv.message_count,
        "flow_message_id": fm.id,
    }


def _build_reply_flow_message(
    *,
    conv_id: str,
    message: str,
    sender_id: Optional[str],
    sender_name: str,
    is_draft: bool = False,
    shared_context_entities: Optional[list[str]] = None,
    remote_worker_session_id: Optional[str] = None,
    kind: Optional[str] = None,
) -> "FlowMessage":
    """Build (but do not save) the FlowMessage entity for a conversation reply.

    The caller is responsible for attaching any uploaded files and then saving.

    ``remote_worker_session_id`` / ``kind``: live-session grouping key and the
    SESSION_EVENT discriminator. Stamped on the header here; the authoritative
    wire carrier is the ``remote_worker_session-<id>`` TYPE_ID attachment the
    caller appends (the hub drops unknown header fields until its schema
    mirrors these).
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

    reply_fm = FlowMessage.model_validate(
        {
            "text": message,
            "shared_context_entities": [str(c) if not isinstance(c, str) else c for c in context],
            "attachment": [],
            "sender_id": sender_id,
            "sender_name": sender_name,
            "conversation_id": conv_id,
            "is_draft": is_draft,
            **({"remote_worker_session_id": remote_worker_session_id} if remote_worker_session_id else {}),
            **({"kind": kind} if kind else {}),
            # The sender authored this message → it is read from their side. Without
            # this the sender's own outgoing message persists is_read=False and the
            # inbox row's unread facet (``!latestMessage.is_read``, which does NOT
            # exclude own messages) shows the conversation as unread on send.
            "is_read": True,
        }
    )
    reply_fm.id = FlowMessage.allocate_id(reply_fm.model_dump())
    reply_fm.attachment = [
        Attachment(
            attachment_type=AttachmentType.TYPE_ID,
            data=str(TypeId(type=BuiltinEntityType.CONVERSATION.value, id=conv_id)),
        ),
        Attachment(
            attachment_type=AttachmentType.TYPE_ID,
            data=str(TypeId(type=BuiltinEntityType.FLOW_MESSAGE.value, id=reply_fm.id)),
        ),
    ]
    return reply_fm


async def _attach_prompt(
    reply_fm: "FlowMessage",
    prompt_text: str,
    prompt_files: list,
    *,
    project_id: Optional[str] = None,
) -> None:
    """Attach prompts as library ``Prompt`` entities (TYPE_ID attachments).

    The typed text and each uploaded *text* prompt file's content are
    minted/reused as real Prompt entities via ``find_or_create_prompt`` (dedup by
    normalized text within the conversation's project scope) and attached as
    TYPE_ID entries carrying ``prompt_preview`` (inline text so receivers can
    preview the prompt before the body bundle downloads). Image / binary prompt files instead keep their
    raw bytes — stored under ``prompt/<name>`` and attached as
    ``AttachmentType.PROMPT`` files so the UI renders them inline as pictures
    rather than decoding the bytes into a garbage prompt. Prompts thus behave
    like every other entity attachment — they ride the body bundle
    (the unified ``_pack_file_backed_attachment``) and land in the receiver's
    project library. Legacy
    ``AttachmentType.PROMPT`` messages
    keep working read-side; new sends are entity-backed.
    """
    from flow_sdk.builtin.flow_message import PROMPT_FILE_VFS_PREFIX, Attachment, AttachmentType
    from flow_sdk.builtin.prompt import Prompt
    from flow_sdk.builtin.prompt_helpers import find_or_create_prompt
    from flow_sdk.storage import get_entity_embedded_storage

    new_atts: list = list(reply_fm.attachment or [])

    # Typed text + each *text* prompt file become library Prompt entities; image
    # / binary files are stored as prompt-file attachments (raw bytes in the
    # FlowMessage VFS under ``prompt/<name>``) so the UI shows them as pictures
    # instead of decoding the bytes into a garbage "prompt".
    texts: list[tuple[str, Optional[str]]] = []  # (text, name hint)
    if prompt_text:
        texts.append((prompt_text, None))

    storage = None
    for uf in prompt_files or []:
        if not hasattr(uf, "read"):
            continue
        filename = getattr(uf, "filename", None) or "prompt.txt"
        raw = await uf.read()
        raw_bytes = bytes(raw) if isinstance(raw, (bytes, bytearray)) else str(raw).encode("utf-8")
        if _prompt_file_is_image_or_binary(filename, raw_bytes):
            if storage is None:
                storage = get_entity_embedded_storage(reply_fm.typeid)
            vfs_subpath = f"{PROMPT_FILE_VFS_PREFIX}{filename}"
            local_path = Path(storage.get_storage_path(vfs_subpath))
            local_path.parent.mkdir(parents=True, exist_ok=True)
            local_path.write_bytes(raw_bytes)
            new_atts.append(
                Attachment(
                    attachment_type=AttachmentType.PROMPT,
                    data=vfs_subpath,
                )
            )
            continue
        content = raw_bytes.decode("utf-8", errors="replace")
        if content.strip():
            texts.append((content, Path(filename).stem or None))

    seen_prompt_ids: set[str] = set()
    for text, name_hint in texts:
        prompt = await find_or_create_prompt(text, project_id=project_id, name=name_hint)
        if prompt.id in seen_prompt_ids:
            continue  # inline text and a file with identical content dedup to one
        seen_prompt_ids.add(prompt.id)
        new_atts.append(
            Attachment(
                attachment_type=AttachmentType.TYPE_ID,
                data=str(TypeId(type=Prompt.get_type(), id=prompt.id)),
                prompt_preview=text,
            )
        )
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


def _parse_share_config(body: dict) -> dict:
    """Decode the share_config carrier (JSON or multipart) into a dict. Both
    share opt-ins (transfer_mode, create_bookmark) read their own key off this."""
    raw = body.get("share_config") or body.get("shareConfig") or {}
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", errors="replace")
    if isinstance(raw, str):
        try:
            raw = _json.loads(raw)
        except Exception:
            raw = {}
    return raw if isinstance(raw, dict) else {}


def _parse_share_transfer_mode(body: dict) -> str:
    """Read share_config.transfer_mode from JSON or multipart bodies."""
    config = _parse_share_config(body)
    mode = (
        config.get("transfer_mode")
        or config.get("transferMode")
        or body.get("transfer_mode")
        or body.get("transferMode")
        or "copy"
    )
    mode = str(mode).strip().lower()
    return mode if mode in {"copy", "git"} else "copy"


def _parse_share_create_bookmark(body: dict) -> bool:
    """Read share_config.create_bookmark (the "create bookmark on the recipient's
    desktop" share opt-in) off the same share_config carrier."""
    config = _parse_share_config(body)
    return bool(config.get("create_bookmark") or config.get("createBookmark"))


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
        logger.warning("[append_conversation] merge shared context failed (non-fatal): %s", e, exc_info=True)


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
                tid,
                e,
                exc_info=True,
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
                tid,
                fm_tid,
                e,
                exc_info=True,
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
        from flow_sdk.builtin.flow_message import FlowMessageKind  # noqa: PLC0415

        attachments = [a.model_dump(mode="python") for a in (reply_fm.attachment or [])]
        shared_context_entities = [str(c) for c in (reply_fm.shared_context_entities or [])]
        kind_value = getattr(reply_fm.kind, "value", reply_fm.kind)
        sendable_kind = FlowMessageKind.sendable(kind_value) if reply_fm.kind else None
        await conv.add_message(
            reply_fm.text,
            sender_name=reply_fm.sender_name or None,
            sender_id=reply_fm.sender_id or None,
            flow_message_id=reply_fm.id,
            attachments=attachments or None,
            shared_context_entities=shared_context_entities or None,
            cloned_from_id=reply_fm.cloned_from_id or None,
            cloned_from_sender_id=reply_fm.cloned_from_sender_id or None,
            remote_worker_session_id=reply_fm.remote_worker_session_id or None,
            kind=sendable_kind.value if sendable_kind else None,
        )
        return True
    except Exception as e:  # noqa: BLE001
        logger.warning("[append_conversation] hub add_message header failed (non-fatal): %s", e, exc_info=True)
        return False


async def _upload_body_and_finalize(
    reply_fm: "FlowMessage",
    conv_id: str,
    *,
    transfer_mode: str = "copy",
    create_bookmark: bool = False,
) -> None:
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
            transfer_mode=transfer_mode,
            create_bookmark=create_bookmark,
        )
        await reply_fm.save()
        _notify_ui_conversation_updated(conv_id, "", reply_fm.id)
    except Exception as e:  # noqa: BLE001
        logger.warning("[append_conversation] background body upload failed (non-fatal): %s", e, exc_info=True)


async def _finalize_message_dispatch(
    conv: "Conversation",
    fm: "FlowMessage",
    context_typeids: list,
    someone_typeid: str,
    *,
    is_remote_send: bool,
    transfer_mode: str = "copy",
    create_bookmark: bool = False,
) -> "Conversation":
    """Shared post-save dispatch tail for an already-saved FlowMessage (a reply
    OR a forwarded clone): backlink the shared-context entities, append the
    conversation.jsonl pointer, refresh the sender's UI, and — for hub-mirrored
    conversations — create the hub header and schedule the body-bundle upload.
    The two send handlers differ only in how the FM is built; this is the part
    that must stay in lock-step. Returns the refreshed conversation."""
    # Mutual context: link each just-shared entity back to this message.
    await _link_message_into_context_entities(fm, context_typeids, someone_typeid)
    # Append pointer + project message_ids before the hub header so the
    # conversation.jsonl is consistent when the body bundle packs.
    conv = await _append_message_to_conversation(
        conv=conv,
        fm_id=fm.id,
        someone_typeid=someone_typeid,
    )
    # Refresh the sender's UI immediately, then create the hub-side header
    # (graph-linked to the parent Conversation so delivery receipts work). The
    # body bundle uploads in a background task.
    _notify_ui_conversation_updated(conv.id, "", fm.id)
    if is_remote_send:
        await _send_conversation_message_header(conv, fm)
        from flow_sdk.builtin.flow_message import BodyStatus  # noqa: PLC0415

        if fm.body_status == BodyStatus.UPLOADING:
            asyncio.create_task(
                _upload_body_and_finalize(
                    fm,
                    conv.id,
                    transfer_mode=transfer_mode,
                    create_bookmark=create_bookmark,
                )
            )
    return conv


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


async def _find_message_committed_before_failure(
    conv_id: str,
    text: str,
    sender_id: Optional[str],
    sent_after: datetime,
) -> Optional[dict]:
    """The message this send may have already written, or None if it truly didn't land.

    Turns "the send failed" back into a fact. Matches on (conversation, exact
    text, sender, created after we started) — ``sent_after`` is what keeps this
    from adopting an OLDER identical message, since sending the same text twice
    on purpose is perfectly normal and must still produce two rows.

    Deliberately conservative: any doubt returns None and the caller re-sends.
    A spurious duplicate is the bug we are fixing, but a silently DROPPED
    message is worse, so the ambiguous cases fail toward re-sending.
    """
    try:
        from flow_sdk.cloud_client.transport.hub_http import hub_get

        rows = await hub_get(BuiltinEntityType.CONVERSATION, conv_id, "flow_message")
    except Exception as e:  # noqa: BLE001
        logger.warning("[append_conversation] post-failure probe for conv=%s failed: %s", conv_id[:8], e)
        return None
    if not isinstance(rows, list):
        # Includes the hub answering with an EMPTY list: ``hub_get`` maps
        # ``data: []`` to ``{}`` (``resp.json().get("data") or {}``), so "the
        # conversation has no messages yet" arrives here, not below.
        logger.warning(
            "[append_conversation] post-failure probe for conv=%s: hub listed no messages — re-sending",
            conv_id[:8],
        )
        return None

    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415

    candidates = []
    for row in rows:
        row_id = row.get("id") if isinstance(row, dict) else None
        if not row_id:
            continue
        if (row.get("text") or "").strip() != text.strip():
            continue
        if sender_id and row.get("sender_id") and row.get("sender_id") != sender_id:
            continue
        created = Conversation._as_datetime(row.get("created_date"))
        if created is None or created < sent_after:
            continue
        # Skip anything already materialized locally: that row belongs to a
        # DIFFERENT send which already claimed it. Without this, two sends of
        # the same text racing each other let the failed one adopt the other's
        # row — the user typed twice and sees one message. Swallowing a message
        # is worse than the duplicate this function exists to prevent.
        if await FlowMessage.get_one({"id": row_id}) is not None:
            continue
        candidates.append((created, row))

    # Exactly one unclaimed match is the only case we can attribute with
    # confidence. Zero means the write never landed. Two or more means several
    # identical messages are in flight and no field distinguishes them — text is
    # not an identity, so guessing risks swallowing one. Both fall back to
    # re-sending, which is the recoverable direction.
    if len(candidates) != 1:
        if candidates:
            logger.warning(
                "[append_conversation] %d indistinguishable committed candidates for conv=%s — re-sending "
                "rather than risk adopting another send's message",
                len(candidates),
                conv_id[:8],
            )
        else:
            # The branch that mints the duplicate, and until now the only one
            # that decided silently. "No match" cannot distinguish *never
            # landed* from *landed but not yet visible*: this probe races the
            # very write it asks about (it fires within ~10ms of the failed
            # send, while the hub exposes the row on the conversation only at
            # the end of its handler). Log what was asked so a duplicate in the
            # field is attributable instead of invisible.
            logger.warning(
                "[append_conversation] post-failure probe for conv=%s found no unclaimed match among %d "
                "hub row(s) created after %s — re-sending (a duplicate here means the hub had committed "
                "the row but had not yet listed it)",
                conv_id[:8],
                len(rows),
                sent_after.isoformat(),
            )
        return None
    return candidates[0][1]


async def _try_send_reply_via_hub(
    *,
    conv_id: str,
    flow_message_id: str,
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

    # Stamped BEFORE the send so the recovery probe below can tell OUR message
    # apart from an older identical one (the same text sent twice on purpose).
    sent_after = datetime.now(timezone.utc)
    try:
        resp = await hub_ws_bridge.add_message(
            conversation_id=conv_id,
            text=text,
            flow_message_id=flow_message_id,
            sender_name=sender_name or None,
        )
    except Exception as e:
        logger.warning("[append_conversation] hub add_message failed: %s", e, exc_info=True)
        # A failed CALL is not a failed WRITE. The hub commits the row before it
        # replies (its ExecutionContext runs with immediate_commit), so a lost
        # reply — a 1011 close, a dropped socket, the send_request timeout —
        # means "unknown", not "failed". Returning None here sends the caller
        # down the HTTP path, which mints a SECOND message: the duplicate users
        # reported, reproduced in
        # ``test_add_message_ambiguous_send_no_duplicate``. Ask the hub what
        # actually happened before deciding.
        fm_payload = await _find_message_committed_before_failure(conv_id, text, sender_id, sent_after)
        if fm_payload is None:
            return None
        logger.info(
            "[append_conversation] send reported failure but the hub had committed %s — adopting it "
            "instead of re-sending",
            str(fm_payload.get("id"))[:8],
        )
    else:
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
        # Sender-side materialize of the sender's OWN message — read from their
        # side. The hub payload carries is_read=False (the hub doesn't track the
        # sender's local read state); adopt True so the sender's conversation
        # doesn't flip unread on send. is_read is a LOCAL_ONLY_FIELD.
        payload["is_read"] = True
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
    # Spread the hub-confirmed FlowMessage fields into the response — see
    # _fm_response_fields for why the id must be carried (SDK mints a random
    # one otherwise).
    return ApiSuccessResponse(
        data={
            **fm_payload,
            "id": hub_fm_id,
            "task_id": "",
            "conversation_id": conv_id,
            "message_count": message_count,
            "flow_message_id": hub_fm_id,
        }
    )


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


async def handle_add_message(
    body: dict,
    someone_typeid: str,
    *,
    pending_send: bool = False,
) -> ApiResponse:
    """Append a message to a Conversation — the single message-send handler.

    Exposed as the `conversation/<id>/add_message` action. Handles text-only
    sends and attachment sends (files, images, prompts, asset references)
    alike. Requires `conversation_id` (project-scoped conversation path); any
    Task is attached via context_entities, not a separate code path.

    ``pending_send``: the caller (the add_message gate) determined the message
    cannot reach the cloud right now — cloud login is required but unavailable.
    Instead of refusing, persist the message locally stamped
    ``delivery_status=pending_send`` with NO hub push; it stays in the
    conversation.jsonl outbox until ``Conversation.deliver_pending_messages``
    pushes it, from ``share()`` or from the hub-session transition in
    ``flow_sdk.inbox.catchup`` (see that module's docstring).
    """
    conversation_id = (body.get("conversation_id") or "").strip()
    # ``text`` is the field the SDK's ``Conversation.addMessage(text)`` sends;
    # accept it as an alias for ``message`` so the canonical SDK path works
    # without callers having to hand-roll a raw ``{message}`` body.
    message = (body.get("message") or body.get("text") or "").strip()
    is_draft = bool(body.get("is_draft"))
    prompt_text_preview = (body.get("prompt_text") or "").strip()
    prompt_files_preview = body.get("prompt_files") or []
    if not isinstance(prompt_files_preview, list):
        prompt_files_preview = [prompt_files_preview]
    uploaded_files_preview = body.get("files") or []
    if not isinstance(uploaded_files_preview, list):
        uploaded_files_preview = [uploaded_files_preview]
    asset_references = _parse_asset_references(body.get("asset_references"))
    transfer_mode = _parse_share_transfer_mode(body)
    create_bookmark = _parse_share_create_bookmark(body)
    # Accept both the new ``shared_context_entities`` name and the legacy
    # ``context_entities`` body key during transition (frontend may not be
    # fully cut over yet). Treat both as wire-bound (shared).
    shared_context_entities = body.get("shared_context_entities") or body.get("context_entities") or []
    if isinstance(shared_context_entities, str):
        shared_context_entities = [shared_context_entities]
    elif not isinstance(shared_context_entities, list):
        shared_context_entities = []
    # Live-session grouping key + the one sendable non-default kind (the enum
    # owns the whitelist, so add-message stays agnostic to which kinds exist).
    from flow_sdk.builtin.flow_message import FlowMessageKind  # noqa: PLC0415

    remote_worker_session_id = (body.get("remote_worker_session_id") or "").strip() or None
    sendable_kind = FlowMessageKind.sendable((body.get("kind") or "").strip() or None)
    message_kind = sendable_kind.value if sendable_kind else None
    # Every prompt is a session turn. A prompt WITHOUT a session id opens a new
    # session: the sender mints the id here (uuid4; the host validates-on-adopt)
    # and the opening proposal (reply policy) rides the start marker on the
    # carrier attachment. A prompt WITH a session id is a follow-up turn.
    from flow_sdk.schema.data_spec.session_spec import SessionStartSettings  # noqa: PLC0415

    is_prompt_send = bool(prompt_text_preview or prompt_files_preview)
    start_settings: Optional[SessionStartSettings] = None
    if is_prompt_send and not remote_worker_session_id:
        from flow_sdk.api.api_types.identifier import mint_uuid  # noqa: PLC0415
        from flow_sdk.builtin.remote_worker_session import ReplyPolicy  # noqa: PLC0415

        raw_policy = (body.get("reply_policy") or "").strip() or ReplyPolicy.AUTO.value
        try:
            reply_policy = ReplyPolicy(raw_policy).value
        except ValueError:
            return ApiFailResponse(message="reply_policy must be 'auto' or 'review'", status_code=400)
        remote_worker_session_id = mint_uuid()
        start_settings = SessionStartSettings(reply_policy=reply_policy)
    elif remote_worker_session_id and is_prompt_send:
        from flow_sdk.builtin.remote_worker_session import RemoteWorkerSession, is_terminal  # noqa: PLC0415

        existing_session = await RemoteWorkerSession.resolve_state(remote_worker_session_id)
        if existing_session is not None and is_terminal(existing_session.status):
            return ApiFailResponse(
                message="this live session has ended — send a new prompt to start another",
                status_code=409,
            )

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
    # parent_share_on_default expansion: flagged types advertise their parent
    # typeid on the rail so receivers re-materialize it.
    parent_typeids = await collect_parent_share_typeids(context_typeids)
    if parent_typeids:
        context_typeids = [*context_typeids, *parent_typeids]
        shared_context_entities = [
            *(shared_context_entities or []),
            *(str(t) for t in parent_typeids),
        ]
    # Shared ClaudeTranscripts may not be indexed yet — materialize their rows
    # first so the merge/backlink below (and the chip's name lookup) resolve.
    await _ensure_claude_session_rows(context_typeids)
    await _merge_shared_context_into_conversation(conv, context_typeids, someone_typeid)

    sender_participant = await User.current_sender_participant(body.get("sender_name"))
    sender_id = sender_participant.get("user_id") or None
    sender_name = sender_participant.get("name") or ""

    # Mint the logical message exactly once, before choosing its transport.
    # If a WebSocket reply is lost after the hub commits, the HTTP fallback
    # must reuse this id: the hub's unique entity id then makes both delivery
    # attempts one write instead of two indistinguishable messages.
    reply_fm = _build_reply_flow_message(
        conv_id=conv.id,
        message=message,
        sender_id=sender_id,
        sender_name=sender_name,
        is_draft=is_draft,
        shared_context_entities=shared_context_entities,
        remote_worker_session_id=remote_worker_session_id,
        kind=message_kind,
    )

    if start_settings is not None:
        # Guest-side row for the session this prompt opens. The host adopts the
        # same id from the carrier; until its first snapshot lands, this row is
        # what renders the card ("requesting" → PENDING).
        from flow_sdk.app.actions.execute_prompt import _peer_of  # noqa: PLC0415
        from flow_sdk.builtin.remote_worker_session import (  # noqa: PLC0415
            RemoteWorkerSession,
            RemoteWorkerSessionStatus,
        )

        peer_id, peer_name, _ = _peer_of(conv, sender_id)
        guest_session = RemoteWorkerSession(
            id=remote_worker_session_id,
            conversation_id=conv.id,
            starting_message_id=reply_fm.id,
            guest_user_id=sender_id,
            guest_name=sender_name or None,
            host_user_id=peer_id,
            host_name=peer_name,
            reply_policy=start_settings.reply_policy,
            status=RemoteWorkerSessionStatus.DRAFT if is_draft else RemoteWorkerSessionStatus.PENDING,
        )
        guest_session.mark_activity()
        await guest_session.save(someone_typeid)

    uploaded_files = body.get("files") or []
    if not isinstance(uploaded_files, list):
        uploaded_files = [uploaded_files]
    prompt_text = (body.get("prompt_text") or "").strip()
    prompt_files = body.get("prompt_files") or []
    if not isinstance(prompt_files, list):
        prompt_files = [prompt_files]

    # Direct Attachment dicts from the SDK's ``addMessage(text, {attachment})``.
    # These must ride the HTTP slow path (conv.add_message forwards them; the
    # WS bridge body is text-only), so the hub sees the body and stamps
    # body_status=UPLOADING instead of NA.
    raw_attachments = body.get("attachment") or []
    if not isinstance(raw_attachments, list):
        raw_attachments = [raw_attachments]

    # Text-only WS fast path. The hub handles fan-out + delivery receipts, then
    # we materialize the hub-confirmed FM locally for the sender's UI. Skipped
    # for a pending_send (no cloud login → never touch the hub; save local).
    if (
        not is_draft
        and not pending_send
        and not uploaded_files
        and not prompt_text
        and not prompt_files
        and not asset_references
        and not raw_attachments
        # Session messages always ride the HTTP slow path: the WS bridge body
        # is text-only and would drop the session-snapshot carrier attachment.
        and not remote_worker_session_id
    ):
        hub_response = await _try_send_reply_via_hub(
            conv_id=conv.id,
            flow_message_id=reply_fm.id,
            text=message,
            sender_name=sender_name,
            sender_id=sender_id,
            someone_typeid=someone_typeid,
        )
        if hub_response is not None:
            return hub_response

    if raw_attachments:
        # Direct Attachment dicts ({attachment_type, data}) from the SDK —
        # adopt them onto the FM so the hub push (conv.add_message) forwards
        # them and ``has_body()`` reflects the real payload.
        from flow_sdk.builtin.flow_message import Attachment  # noqa: PLC0415

        _atts = list(reply_fm.attachment or [])
        for _a in raw_attachments:
            if isinstance(_a, dict) and _a.get("attachment_type") and _a.get("data") is not None:
                # Preserve the preview so entity-backed attachments (prompt /
                # prompt_completion) stay previewable before the body downloads.
                _atts.append(
                    Attachment(
                        attachment_type=_a["attachment_type"],
                        data=_a["data"],
                        prompt_preview=_a.get("prompt_preview"),
                    )
                )
        reply_fm.attachment = _atts

    if uploaded_files:
        await _attach_uploaded_files(reply_fm, uploaded_files)

    if asset_references:
        await _attach_asset_references(reply_fm, asset_references)

    if prompt_text or prompt_files:
        await _attach_prompt(
            reply_fm,
            prompt_text,
            prompt_files,
            project_id=getattr(conv, "project_id", None) or None,
        )

    if remote_worker_session_id:
        # Authoritative wire carrier for the live-session key (the hub drops
        # the header field until its schema mirrors it): a
        # ``remote_worker_session-<id>`` TYPE_ID attachment. The bundle packer
        # serializes the session row at upload time, so every session message
        # ships a fresh snapshot. Skip when the caller already attached one.
        from flow_sdk.builtin.flow_message import Attachment, AttachmentType  # noqa: PLC0415

        session_att_data = f"remote_worker_session-{remote_worker_session_id}"
        if not any(
            a.attachment_type == AttachmentType.TYPE_ID and a.data == session_att_data
            for a in (reply_fm.attachment or [])
        ):
            marker = None
            if start_settings is not None:
                import json as _json  # noqa: PLC0415

                from flow_sdk.builtin.flow_message import SESSION_START_MARKER_KEY  # noqa: PLC0415

                marker = _json.dumps({SESSION_START_MARKER_KEY: start_settings.model_dump()})
            reply_fm.attachment = [
                *(reply_fm.attachment or []),
                Attachment(attachment_type=AttachmentType.TYPE_ID, data=session_att_data, prompt_preview=marker),
            ]
        await _stamp_session_snapshot(reply_fm, remote_worker_session_id)

    # A conversation reply goes to the hub whenever it's hub-mirrored
    # (``conv.remote`` is the load-bearing signal). Local-only conversations
    # keep body_status=NA — the attachment is served off local VFS.
    is_remote_send = not pending_send and is_logged_in() and bool(getattr(conv, "remote", False))
    if is_remote_send and reply_fm.has_body():
        from flow_sdk.builtin.flow_message import BodyStatus  # noqa: PLC0415

        reply_fm.body_status = BodyStatus.UPLOADING

    if pending_send:
        # Composed offline — stamp the local-only pre-accept status so the UI /
        # CLI can show it as queued. It rides the jsonl outbox for a later flush.
        from flow_sdk.builtin.flow_message import DeliveryStatus  # noqa: PLC0415

        reply_fm.delivery_status = DeliveryStatus.PENDING_SEND.value

    reply_fm = await reply_fm.save(someone_typeid)

    if is_draft:
        # Local-only draft: skip jsonl append and hub push.
        # The UI surfaces the draft via an entity query on (conversation_id, is_draft=true).
        return ApiSuccessResponse(data={**_fm_response_fields(reply_fm, conv), "is_draft": True})

    conv = await _finalize_message_dispatch(
        conv,
        reply_fm,
        context_typeids,
        someone_typeid,
        is_remote_send=is_remote_send,
        transfer_mode=transfer_mode,
        create_bookmark=create_bookmark,
    )

    return ApiSuccessResponse(data=_fm_response_fields(reply_fm, conv))


def _copy_clone_storage(src_fm: "FlowMessage", clone_fm: "FlowMessage") -> None:
    """Copy FILE / PROMPT-file bytes from the source message's embedded storage
    into the clone's. Embedded storage is keyed by entity id, so the cloned
    attachments' VFS subpaths resolve only once the bytes exist under the new
    id. Missing source files are skipped (an un-downloaded remote body) — the
    clone still references them and the bundle re-pulls from the hub."""
    import shutil  # noqa: PLC0415

    from flow_sdk.builtin.flow_message import (  # noqa: PLC0415
        PROMPT_FILE_VFS_PREFIX,
        AttachmentType,
    )
    from flow_sdk.storage import get_entity_embedded_storage  # noqa: PLC0415

    src_storage = get_entity_embedded_storage(src_fm.typeid)
    clone_storage = get_entity_embedded_storage(clone_fm.typeid)
    for att in clone_fm.attachment or []:
        vfs_subpath: Optional[str] = None
        if att.attachment_type == AttachmentType.FILE:
            vfs_subpath = att.data or ""
        elif att.attachment_type == AttachmentType.PROMPT and (att.data or "").startswith(PROMPT_FILE_VFS_PREFIX):
            vfs_subpath = att.data
        if not vfs_subpath:
            continue
        src_path = Path(src_storage.get_storage_path(vfs_subpath))
        if not src_path.exists():
            continue
        dest_path = Path(clone_storage.get_storage_path(vfs_subpath))
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src_path, dest_path)


async def handle_forward_message(body: dict, someone_typeid: str) -> ApiResponse:
    """Forward an existing FlowMessage into another conversation.

    Exposed as the ``flow_message/<id>/forward`` action. Clones the source
    message (new id, the forwarder as sender, fresh timestamps,
    ``cloned_from_id`` provenance, deep-copied attachments + bytes) and then
    dispatches the clone exactly like ``handle_add_message`` dispatches a new
    reply: save → context links → conversation.jsonl append → hub header →
    background body upload.
    """
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415

    flow_message_id = (body.get("flow_message_id") or "").strip()
    conversation_id = (body.get("conversation_id") or "").strip()
    if not flow_message_id:
        return ApiFailResponse(message="flow_message_id is required")
    if not conversation_id:
        return ApiFailResponse(message="conversation_id is required")

    src_fm = await FlowMessage.get_one({"id": flow_message_id})
    if not src_fm:
        return ApiFailResponse(message=f"FlowMessage not found: {flow_message_id}")
    conv = await Conversation.get_one({"id": conversation_id})
    if not conv:
        return ApiFailResponse(message=f"Conversation not found: {conversation_id}")
    if src_fm.conversation_id == conversation_id:
        return ApiFailResponse(message="Cannot forward a message into its own conversation")

    sender_participant = await User.current_sender_participant(body.get("sender_name"))
    sender_id = sender_participant.get("user_id") or None
    sender_name = sender_participant.get("name") or ""

    clone_fm = src_fm.clone_for_forward(
        conversation_id=conv.id,
        sender_id=sender_id,
        sender_name=sender_name,
    )
    _copy_clone_storage(src_fm, clone_fm)

    # The forwarded content becomes shared context of the TARGET conversation,
    # same as a fresh share of those assets would.
    from flow_sdk.builtin.flow_message import AttachmentType  # noqa: PLC0415

    content_refs = [att.data for att in (clone_fm.attachment or []) if att.attachment_type == AttachmentType.TYPE_ID]
    context_typeids = _parse_context_typeids(conv, content_refs, [])
    # parent_share_on_default expansion — same rule as handle_add_message, so
    # forwarding a chip advertises its parent exactly like a fresh share.
    parent_typeids = await collect_parent_share_typeids(context_typeids)
    if parent_typeids:
        context_typeids = [*context_typeids, *parent_typeids]
        clone_fm.add_shared_context_entities(*parent_typeids)
    await _ensure_claude_session_rows(context_typeids)
    await _merge_shared_context_into_conversation(conv, context_typeids, someone_typeid)

    is_remote_send = is_logged_in() and bool(getattr(conv, "remote", False))
    if is_remote_send and clone_fm.has_body():
        from flow_sdk.builtin.flow_message import BodyStatus  # noqa: PLC0415

        clone_fm.body_status = BodyStatus.UPLOADING

    clone_fm = await clone_fm.save(someone_typeid)

    conv = await _finalize_message_dispatch(
        conv,
        clone_fm,
        context_typeids,
        someone_typeid,
        is_remote_send=is_remote_send,
    )

    return ApiSuccessResponse(
        data={
            "conversation_id": conv.id,
            "message_count": conv.message_count,
            "flow_message_id": clone_fm.id,
            "cloned_from_id": clone_fm.cloned_from_id,
        }
    )


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


async def _stamp_session_snapshot(fm: "FlowMessage", session_id: str) -> None:
    """Put the session's wire snapshot on the carrier's ``prompt_preview``
    (a hub-known field) so the other side flips state on fan-out — seconds
    before the body bundle, which carries the same snapshot durably. Merges
    into whatever marker is already there (``session_start`` /
    ``live_session_event``). No local row → nothing to stamp."""
    import json as _json  # noqa: PLC0415

    from flow_sdk.builtin.flow_message import (  # noqa: PLC0415
        SESSION_SNAPSHOT_MARKER_KEY,
        AttachmentType,
        _carrier_marker,
    )
    from flow_sdk.builtin.remote_worker_session import RemoteWorkerSession  # noqa: PLC0415

    rws = await RemoteWorkerSession.resolve_state(session_id)
    if rws is None:
        return
    carrier_data = f"remote_worker_session-{session_id}"
    out = []
    for a in fm.attachment or []:
        if a.attachment_type == AttachmentType.TYPE_ID and a.data == carrier_data:
            marker: dict = {**(_carrier_marker(fm) or {}), SESSION_SNAPSHOT_MARKER_KEY: rws.snapshot()}
            a = a.model_copy(update={"prompt_preview": _json.dumps(marker)})
        out.append(a)
    fm.attachment = out


def _is_prompt_attachment(a: Any) -> bool:
    """True for any prompt attachment kind: legacy inline/file ``PROMPT``,
    or an entity-backed TYPE_ID entry pointing at a ``prompt`` entity.

    CONTRACT: the type literal must equal ``Prompt.get_type()`` and the FE
    mirror (``ui/.../attachment-actions/prompt-attachment.ts``) must match —
    both sides gate the same approve/preview behavior off this predicate.
    """
    from flow_sdk.builtin.flow_message import AttachmentType  # noqa: PLC0415

    if a.attachment_type == AttachmentType.PROMPT:
        return True
    if a.attachment_type == AttachmentType.TYPE_ID:
        # data is "<type>-<id>"; type is everything before the first dash
        # (same convention as flow_message._type_id_record_materialized).
        return (a.data or "").split("-", 1)[0] == "prompt"
    return False


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
        git_origin=(meta.get("git_origin") or (data or {}).get("git_origin")),
        sender_name=(meta.get("sender_name") or (data or {}).get("sender_name") or "").strip(),
        title=(meta.get("task_title") or (data or {}).get("task_title") or "").strip(),
    )
