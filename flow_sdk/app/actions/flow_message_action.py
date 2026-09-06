"""HTTP actions for FlowMessage file transport.

POST /api/v1/graph/flow-message-upload      — upload .flowmsg (multipart, global action)
GET  /api/v1/graph/flow_message/{id}/create-and-download-local-flowmsg  — download .flowmsg (entity-scoped)
GET  /api/v1/graph/flow_message/{id}/open   — deep-link: fetch from hub and open IncomingTaskDialog
"""

import asyncio
import contextlib
import json as _json
import logging
import os
import re
import tempfile
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, NamedTuple, Optional
from weakref import WeakValueDictionary

from flow_sdk import inbox
from flow_sdk._compat import UTC
from flow_sdk.actions.action_registry import action
from flow_sdk.app.helpdesk_resolver import resolve_adopted_helpdesk
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import BodyStatus, DeliveryStatus, FlowMessage, FlowMessageKind
from flow_sdk.builtin.flow_message_bundle import FlowMessageExistsError
from flow_sdk.builtin.task import Task
from flow_sdk.builtin.team import Team
from flow_sdk.builtin.user import User, normalize_email
from flow_sdk.cloud_client.transport.hub_http import rows_of
from flow_sdk.core.entity.entity_model import remote_reflection
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.fs_store.operations.conversation import (
    append_message_pointer,
    default_jsonl_path,
    from_jsonl,
    message_pointers,
    project_pointers_to_entity,
    prune_message_pointer,
    write_pointers,
)
from flow_sdk.fs_store.pointer import Pointer
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.inbox.agent_scope import (
    AgentInboxScope,
    AgentInboxScopeError,
    resolve_agent_inbox_scope,
)
from flow_sdk.inbox.hub_clock import adopt_hub_created_date, hub_created_drift
from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.utils.hub import HubError, hub_base_url, hub_get, hub_post

logger = logging.getLogger(__name__)

# Same-message body pulls can arrive concurrently from the conversation sync and
# the eager hub bridge. ``unpack_bundle`` replaces one shared staging directory,
# so those callers must not run its rmtree/copytree sequence at the same time.
# Locks are loop-scoped (asyncio locks cannot cross pytest/server event loops)
# and weakly held so a long-lived backend does not retain one per message.
_BUNDLE_DOWNLOAD_LOCKS: "WeakValueDictionary[tuple[object, str], asyncio.Lock]" = WeakValueDictionary()

if TYPE_CHECKING:
    from flow_sdk.builtin.invitation import Invitation


async def _optional_agent_inbox_scope(agent_id: object) -> AgentInboxScope | None:
    """Resolve an explicitly requested Agent scope; blank preserves legacy behavior."""
    value = str(agent_id or "").strip()
    return await resolve_agent_inbox_scope(value) if value else None


def _body_status_value(status: str | BodyStatus | None) -> str | None:
    return status.value if isinstance(status, BodyStatus) else status


def _meaningful_name(title: str) -> str:
    name = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return name[:60] or "untitled"


def _participant_value(participant: dict, *keys: str) -> Optional[str]:
    if not isinstance(participant, dict):
        return None
    for key in keys:
        value = participant.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _local_roster_key(k: str) -> str:
    """Wire adapter: the hub sends the roster under ``participants``; the local
    cache field is the generic ``Entity.members``. Map that one key; pass others
    through. Used by both hub-conv metadata upsert loops."""
    return "members" if k == "participants" else k


def _normalize_participants(participants: list[dict]) -> list[dict]:
    normalized: list[dict] = []
    for participant in participants or []:
        if not isinstance(participant, dict):
            continue
        item = dict(participant)
        email = normalize_email(_participant_value(participant, "email", "user_email"))
        name = _participant_value(participant, "name", "user_name")
        picture = _participant_value(participant, "picture", "user_picture")
        if isinstance(item.get("email"), str):
            item["email"] = normalize_email(item["email"]) or ""
        if email and not item.get("email"):
            item["email"] = email
        if name and not item.get("name"):
            item["name"] = name
        if picture and not item.get("picture"):
            item["picture"] = picture
        normalized.append(item)
    return normalized


def _participant_label(participant: dict) -> str:
    if not isinstance(participant, dict):
        return "unknown"
    return (
        _participant_value(participant, "name", "user_name")
        or _participant_value(participant, "email", "user_email")
        or "unknown"
    )


def participant_identity_key(participant: dict) -> str:
    """Canonical identity key for a participant: ``user_id || email || name``,
    lowercased. Mirrors the frontend ``participantKey`` (``use-contacts.ts``) so
    the backend scan/matcher and the UI agree on "the same person".
    """
    value = (
        _participant_value(participant, "user_id", "user_id")
        or _participant_value(participant, "email", "user_email")
        or _participant_value(participant, "name", "user_name")
        or ""
    )
    return value.strip().lower()


async def _learn_address_book(participants: list[dict]) -> int:
    """Upsert every participant into the address book. Keyed on user_id OR email
    (a hub-only participant carries a ``user_id`` and no email). Returns the
    number of participants that produced/updated a contact. The single per-roster
    learner — reused by create/receive/share and the address-book scan.
    """
    return await _learn_normalized_participants(_normalize_participants(participants))


async def _learn_normalized_participants(participants: list[dict]) -> int:
    """Learner fast-path for callers that already hold a normalized roster —
    skips the re-normalization. See :func:`_learn_address_book`.
    """
    upserted = 0
    for participant in participants:
        email = _participant_value(participant, "email")
        user_id = _participant_value(participant, "user_id")
        if not email and not user_id:
            continue
        name = _participant_value(participant, "name")
        picture = _participant_value(participant, "picture")
        # remote defaults False: a learned contact is a LOCAL mirror minted at a
        # local uuid5 id, not a hub entity at the same id — marking it remote
        # would wrongly route ops through hub-reflection.
        contact = await User.upsert_contact(user_id=user_id, email=email, name=name, picture=picture)
        if contact is not None:
            upserted += 1
    return upserted


async def handle_upload_flow_message(file, overwrite: bool) -> ApiResponse:
    """Accept a .flowmsg zip upload and materialize entities."""
    local_user = await User.get_one({"uname": "local"})
    local_user_id = local_user.id if local_user else ""

    with tempfile.NamedTemporaryFile(suffix=".flowmsg", delete=False) as tmp:
        tmp_path = Path(tmp.name)
        content = await file.read()
        tmp.write(content)

    try:
        fm = await FlowMessage.from_file(tmp_path, local_user_id, overwrite=overwrite)
    except FlowMessageExistsError as exc:
        return ApiFailResponse(
            message="FlowMessage already exists",
            status_code=409,
            data={"conflicts": exc.conflicts},
        )
    finally:
        tmp_path.unlink(missing_ok=True)

    task_id = next((c.id for c in fm.shared_context_entities if c.type == BuiltinEntityType.TASK.value), None)
    conv_id = next((c.id for c in fm.shared_context_entities if c.type == BuiltinEntityType.CONVERSATION.value), None)

    return ApiSuccessResponse(
        data={
            "message_id": fm.id,
            "task_id": task_id,
            "conversation_id": conv_id,
            "was_new_task": True,
        }
    )


async def handle_download_flow_message(fm_id: str) -> ApiResponse:
    """Stream a .flowmsg zip for a FlowMessage entity."""
    from fastapi.responses import FileResponse
    from starlette.background import BackgroundTask

    fm = await FlowMessage.get_one({"id": fm_id})
    if not fm:
        return ApiFailResponse(message=f"FlowMessage not found: {fm_id}", status_code=404)

    zip_path = await fm.to_file()
    sender = re.sub(r"[^a-z0-9]+", "-", (fm.sender_name or "unknown").lower()).strip("-")[:30]
    dt = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    filename = f"{sender}-{dt}.flowmsg"

    return FileResponse(
        str(zip_path),
        media_type="application/zip",
        filename=filename,
        background=BackgroundTask(lambda: os.unlink(zip_path) if zip_path.exists() else None),
    )


@action.post(action_name="flow-message-upload", types=None)
async def upload_flow_message() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info:
            return ApiFailResponse(message="No request info found")
        if not request_info.someone_typeid:
            return ApiFailResponse(message="No authenticated user in request context")

        post_data = await request_info.get_post_data() or {}
        upload_file = post_data.get("file")
        if not upload_file or not hasattr(upload_file, "read"):
            return ApiFailResponse(message="No file uploaded", status_code=400)

        overwrite_qp = request_info.request.query_params.get("overwrite", "false")
        overwrite_form = str(post_data.get("overwrite", "false")).lower()
        overwrite = overwrite_qp.lower() in ("true", "1", "yes") or overwrite_form in ("true", "1", "yes")
        return await handle_upload_flow_message(upload_file, overwrite)
    except Exception as e:
        logger.error(f"[flow_message_action] upload error: {e}", exc_info=True)
        return ApiFailResponse(message=f"Upload failed: {str(e)}")


async def handle_open_flow_message(fm_id: str) -> ApiResponse:
    """Fetch FlowMessage from hub, materialise bundle if needed, delegate to deep-link handler."""
    from flow_sdk.server.routes.notify import handle_notification_deep_link

    data = await hub_get(BuiltinEntityType.FLOW_MESSAGE, fm_id)
    meta = (data or {}).get("metadata") or {}

    attachment_filename = ((data or {}).get("attachment_filename") or "").strip()

    # Always download/unpack the specific message's bundle when one exists.
    # The bundle materializes the local FlowMessage (and its Conversation /
    # optional Task), so the UI deep link can navigate directly without
    # needing a separate FM lookup. Scenario B has no Task — only the bundle
    # gates the download.
    if attachment_filename:
        try:
            await _download_and_unpack_bundle(
                fm_id,
                attachment_filename,
                body_status=(data or {}).get("body_status"),
                hub_updated=(data or {}).get("updated_date"),
            )
        except Exception as e:
            logger.warning("[open_flow_message] failed to materialize bundle (non-fatal): %s", e)

    # Resolve conversation_id / task_id. Try the local FM first (populated by
    # ``_download_and_unpack_bundle`` above). When there's no bundle — e.g. a
    # text-only first message from ``NewConversationDialog`` — the local FM
    # never materializes; we additionally walk the conv's hub-side parent
    # relationship so the deep link still carries conv_id and we can sync
    # the conv content directly from the hub below.
    conversation_id = ""
    task_id = ""
    local_fm = await FlowMessage.get_one({"id": fm_id})
    if local_fm:
        conversation_id = getattr(local_fm, "conversation_id", "") or ""
        for ctx in local_fm.shared_context_entities or []:
            if getattr(ctx, "type", None) == BuiltinEntityType.TASK.value and not task_id:
                task_id = getattr(ctx, "id", "") or ""
    else:
        # Fall back to the hub's context list (string typeids like
        # "conversation-<uuid>"). Format kept loose to tolerate variations.
        # Accept both the new ``shared_context_entities`` key and the legacy
        # ``context_entities`` key in case the hub hasn't fully cut over.
        hub_ctx = (data or {}).get("shared_context_entities") or (data or {}).get("context_entities") or []
        for raw in hub_ctx:
            s = raw if isinstance(raw, str) else str(raw)
            if s.startswith(f"{BuiltinEntityType.CONVERSATION.value}-") and not conversation_id:
                conversation_id = s.split("-", 1)[1]
            elif s.startswith(f"{BuiltinEntityType.TASK.value}-") and not task_id:
                task_id = s.split("-", 1)[1]
        if not task_id:
            task_id = (meta.get("task_id") or (data or {}).get("task_id") or "").strip()

    # When the conv is known but not yet on the recipient's local DB, sync it
    # directly from the hub (the bundle-unpack path normally does this, but
    # text-only first messages ship without a bundle).
    if conversation_id:
        try:
            request_info = get_current_request_info()
            someone_typeid = request_info.someone_typeid if request_info else None
            if someone_typeid:
                await _ensure_local_conversation_synced(conversation_id, someone_typeid)
        except Exception as e:
            logger.warning("[open_flow_message] conv sync failed (non-fatal): %s", e, exc_info=True)

    logger.warning(
        "[open_flow_message] fm_id=%s attachment_filename=%r conv_id=%s task_id=%s",
        fm_id,
        attachment_filename,
        conversation_id,
        task_id,
    )

    return await handle_notification_deep_link(
        fm_id=fm_id,
        conversation_id=conversation_id,
        task_id=task_id,
        git_origin=(meta.get("git_origin") or (data or {}).get("git_origin")),
        sender_name=(meta.get("sender_name") or (data or {}).get("sender_name") or "").strip(),
        title=(meta.get("task_title") or meta.get("spec_title") or (data or {}).get("task_title") or "").strip(),
    )


@action.get(action_name="open", types=[BuiltinEntityType.FLOW_MESSAGE.value])
async def open_flow_message() -> ApiResponse:
    """Deep-link handler: fetch FlowMessage from hub and redirect to IncomingTaskDialog."""
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No request info found", status_code=400)
        return await handle_open_flow_message(str(request_info.target_entity_typeid.id))
    except Exception as e:
        logger.error("[flow_message_action] open error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Open failed: {str(e)}")


@action.get(action_name="create-and-download-local-flowmsg", types=["flow_message"])
async def download_flow_message() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No request info found")

        return await handle_download_flow_message(str(request_info.target_entity_typeid.id))
    except Exception as e:
        logger.error(f"[flow_message_action] download error: {e}", exc_info=True)
        return ApiFailResponse(message=f"Download failed: {str(e)}")


# ---------------------------------------------------------------------------
# Header / Body interface (principle #6 — exposes FlowMessage body methods
# over HTTP so the UI + vitest tests can drive the same contract).
# ---------------------------------------------------------------------------


async def _load_fm_local_or_hub(fm_id: str) -> Optional[FlowMessage]:
    """Get the FM from the local DB; on miss, fall back to the hub.

    Sender-side, the local DB lags the hub (Conversation.add_message goes
    straight to the hub and the bridge fanout skips the sender), so a freshly-
    created FM exists on the hub before it lands locally. The fallback keeps
    body actions usable in that window.
    """
    fm = await FlowMessage.get_one({"id": fm_id})
    if fm is not None:
        return fm
    from flow_sdk.utils.hub import hub_get

    payload = await hub_get(BuiltinEntityType.FLOW_MESSAGE, fm_id)
    if not payload:
        return None
    return FlowMessage.model_validate(payload)


async def handle_has_body(fm_id: str) -> ApiResponse:
    """Return whether the FM has body-requiring attachments."""
    fm = await _load_fm_local_or_hub(fm_id)
    if not fm:
        return ApiFailResponse(message=f"FlowMessage not found: {fm_id}", status_code=404)
    return ApiSuccessResponse(data={"has_body": fm.has_body()})


async def handle_upload_body(fm_id: str, *, transfer_mode: str = "copy") -> ApiResponse:
    """Pack + upload this message's body bundle. Idempotent: a second call
    re-uploads (the hub PUT overwrites). On failure the hub-side body_status
    remains UPLOADING and the exception surfaces as an ApiFailResponse."""
    fm = await _load_fm_local_or_hub(fm_id)
    if not fm:
        return ApiFailResponse(message=f"FlowMessage not found: {fm_id}", status_code=404)
    from flow_sdk.core.network.resource_tracker import make_flow_message_progress_emitter

    try:
        await fm.upload_body(
            on_progress=make_flow_message_progress_emitter(fm_id, "upload"),
            transfer_mode=transfer_mode,
        )
    except Exception as e:
        logger.error("[flow_message_action] upload_body fm=%s: %s", fm_id, e, exc_info=True)
        return ApiFailResponse(message=f"upload_body failed: {e}")
    return ApiSuccessResponse(
        data={
            "flow_message_id": fm.id,
            "body_status": _body_status_value(fm.body_status),
            "attachment_filename": fm.attachment_filename,
        }
    )


async def handle_download_body(fm_id: str, *, overwrite: bool = False) -> ApiResponse:
    """Download + unpack this message's body bundle. Refuses (BodyNotReadyError)
    if body_status != READY — receivers must wait for the hub UPDATE fanout.

    ``overwrite`` — replace an existing on-disk asset on a genuine collision. On
    a conflict with ``overwrite=False`` this returns a 409 carrying
    ``asset_conflict`` + the conflicting paths so the UI can prompt the user and
    re-POST with ``overwrite=True``."""
    from flow_sdk.builtin.flow_message import BodyNotReadyError
    from flow_sdk.builtin.flow_message_bundle import FlowMessageExistsError
    from flow_sdk.core.network.resource_tracker import make_flow_message_progress_emitter

    fm = await _load_fm_local_or_hub(fm_id)
    if not fm:
        return ApiFailResponse(message=f"FlowMessage not found: {fm_id}", status_code=404)
    # File-backed assets unpack into the message's STAGING area (record-data
    # dir) and surface as MessageAttachment rows — no project needed here;
    # placement happens in the explicit message_attachment install action.
    try:
        await fm.download_body(
            overwrite=overwrite,
            on_progress=make_flow_message_progress_emitter(fm_id, "download"),
        )
    except BodyNotReadyError as e:
        return ApiFailResponse(message=str(e), status_code=409)
    except FlowMessageExistsError as e:
        # Actionable conflict: surface the paths so the UI can ask "asset
        # already exists — overwrite?" and re-POST with overwrite=True.
        return ApiFailResponse(
            message="asset already exists — overwrite?",
            status_code=409,
            data={"asset_conflict": True, "conflicts": getattr(e, "conflicts", None)},
        )
    except Exception as e:
        logger.error("[flow_message_action] download_body fm=%s: %s", fm_id, e, exc_info=True)
        return ApiFailResponse(message=f"download_body failed: {e}")
    return ApiSuccessResponse(
        data={
            "flow_message_id": fm.id,
            "body_status": _body_status_value(fm.body_status),
        }
    )


@action.get(action_name="has_body", types=["flow_message"])
async def has_body_action() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No request info found", status_code=400)
        return await handle_has_body(str(request_info.target_entity_typeid.id))
    except Exception as e:
        logger.error(f"[flow_message_action] has_body error: {e}", exc_info=True)
        return ApiFailResponse(message=f"has_body failed: {e}")


@action.post(action_name="upload_body", types=["flow_message"])
async def upload_body_action() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No request info found", status_code=400)
        body = await request_info.get_post_data() or {}
        # _normalize_transfer_mode (bundle packer) is the single strip/lower/validate point.
        transfer_mode = (body.get("transfer_mode") if isinstance(body, dict) else None) or "copy"
        return await handle_upload_body(str(request_info.target_entity_typeid.id), transfer_mode=transfer_mode)
    except Exception as e:
        logger.error(f"[flow_message_action] upload_body error: {e}", exc_info=True)
        return ApiFailResponse(message=f"upload_body failed: {e}")


@action.post(action_name="download_body", types=["flow_message"])
async def download_body_action() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No request info found", status_code=400)
        body = await request_info.get_post_data() or {}
        overwrite = bool(body.get("overwrite", False))
        return await handle_download_body(
            str(request_info.target_entity_typeid.id),
            overwrite=overwrite,
        )
    except Exception as e:
        logger.error(f"[flow_message_action] download_body error: {e}", exc_info=True)
        return ApiFailResponse(message=f"download_body failed: {e}")


# ---------------------------------------------------------------------------
# Project-scoped conversation creation (no Task)
# ---------------------------------------------------------------------------


async def handle_create_project_conversation(
    project_id: str,
    participants: list[dict],
    someone_typeid: str,
    title: Optional[str] = None,
    shared_context_entities: Optional[list] = None,
) -> ApiResponse:
    """Create a Conversation directly under a Project (no Task).

    Each participant entry is {email, name?}. Every email is upserted as a
    local User so the contact list grows automatically. `title` becomes the
    conversation's display name; when omitted, falls back to a participants
    summary.

    The owning project is DERIVED from the shared/target entity, not the
    client's ambient active project: when ``shared_context_entities`` carry an
    entity with a project, that project wins — ``project_id`` (the request's
    ambient default) is only the fallback. This keeps the assignment
    deterministic and computed once at create (see ``Conversation.resolve_project_id``).
    """
    from flow_sdk.builtin.project import Project

    effective_project_id = await Conversation.resolve_project_id(shared_context_entities, fallback=project_id)
    if not effective_project_id:
        return ApiFailResponse(message="project_id is required")

    project = await Project.get_one({"id": effective_project_id})
    if not project:
        return ApiFailResponse(message=f"Project not found: {effective_project_id}", status_code=404)

    resolved = list(participants or [])
    await _learn_address_book(resolved)

    derived_name = (title or "").strip() or (", ".join(_participant_label(p) for p in resolved) or None)

    conv = Conversation.model_validate(
        {
            "task_id": None,
            "project_id": project.id,
            "members": resolved,  # roster cache (Entity base); populated at create
            # Stamp the shared context at create so the project chip + context
            # links resolve from the conversation itself (not only the first message).
            "shared_context_entities": list(shared_context_entities or []),
            # `title` is the user-set display title (NewConversationDialog).
            # `name` mirrors it for legacy consumers that still read `conv.name`.
            "title": (title or "").strip() or None,
            "name": derived_name,
        }
    )
    conv.id = Conversation.allocate_id(conv.model_dump())
    conv = await conv.save(someone_typeid)
    await project.attach_child(conv)

    # Canonical jsonl path is auto-created under records-data root.
    jsonl_path = default_jsonl_path(conv.id)
    rec = from_jsonl(jsonl_path, project.id, conv.id, parent_type=RecordType.PROJECT)
    rec.save()

    return ApiSuccessResponse(
        data={
            "conversation_id": conv.id,
            "project_id": project.id,
            "participants": resolved,
            "name": conv.name,
        }
    )


async def handle_conversation_dismiss(conversation_id: str, someone_typeid: str) -> ApiResponse:
    """Stamp ``Conversation.dismissed_at = now()`` so the Recent strip hides
    this row until a FlowMessage newer than the stamp arrives. The Inbox
    ignores ``dismissed_at`` — Inbox dismissal is a separate concept driven
    by per-message ``is_archived``.
    """
    conversation_id = (conversation_id or "").strip()
    if not conversation_id:
        return ApiFailResponse(message="conversation_id required")
    conv = await Conversation.get_one({"id": conversation_id})
    if conv is None:
        return ApiFailResponse(message="Conversation not found")
    conv.dismissed_at = datetime.now(UTC)
    await conv.save(someone_typeid)
    return ApiSuccessResponse(
        data={
            "conversation_id": conversation_id,
            "dismissed_at": conv.dismissed_at.isoformat() if conv.dismissed_at else None,
        }
    )


@action.post(action_name="conversation-dismiss", types=None)
async def conversation_dismiss() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        body = await request_info.get_post_data() or {}
        conv_id = (body.get("conversation_id") or "").strip()
        return await handle_conversation_dismiss(conv_id, request_info.someone_typeid)
    except Exception as e:
        logger.error("[flow_message_action] conversation-dismiss error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed: {e}")


async def handle_conversation_archive(
    conversation_id: str,
    someone_typeid: str,
    *,
    allowed_conversation_ids: frozenset[str] | None = None,
) -> ApiResponse:
    """Stamp ``Conversation.archived_at = now()``.

    Both Inbox and Recent strip hide the row when set; a FlowMessage newer
    than the stamp auto-revives it. Conversation-level archive — does NOT
    touch ``FlowMessage.is_read`` (those are per-message and remain
    independent). Idempotent: re-archiving already-archived row is a
    no-op (the stamp doesn't move backward in time, but the function
    re-stamps with the current time, which is harmless).
    """
    conversation_id = (conversation_id or "").strip()
    if not conversation_id:
        return ApiFailResponse(message="conversation_id required")
    if allowed_conversation_ids is not None and conversation_id not in allowed_conversation_ids:
        return ApiFailResponse(message="Conversation is not in this Agent inbox", status_code=404)
    conv = await Conversation.get_one({"id": conversation_id})
    if conv is None:
        return ApiFailResponse(message="Conversation not found")
    conv.archived_at = datetime.now(UTC)
    await conv.save(someone_typeid)
    inbox.touch("conversation-archive")
    return ApiSuccessResponse(
        data={
            "conversation_id": conversation_id,
            "archived_at": conv.archived_at.isoformat() if conv.archived_at else None,
        }
    )


async def handle_conversation_unarchive(
    conversation_id: str,
    someone_typeid: str,
    *,
    allowed_conversation_ids: frozenset[str] | None = None,
) -> ApiResponse:
    """Clear ``Conversation.archived_at`` (back to ``None``).

    The manual inverse of :func:`handle_conversation_archive` — the same effect
    the auto-revive achieves when a newer FlowMessage arrives. Local-only (the
    hub never sees ``archived_at``). Idempotent: unarchiving a non-archived row
    re-stamps ``None``, which is harmless.
    """
    conversation_id = (conversation_id or "").strip()
    if not conversation_id:
        return ApiFailResponse(message="conversation_id required")
    if allowed_conversation_ids is not None and conversation_id not in allowed_conversation_ids:
        return ApiFailResponse(message="Conversation is not in this Agent inbox", status_code=404)
    conv = await Conversation.get_one({"id": conversation_id})
    if conv is None:
        return ApiFailResponse(message="Conversation not found")
    conv.archived_at = None
    await conv.save(someone_typeid)
    inbox.touch("conversation-unarchive")
    return ApiSuccessResponse(
        data={
            "conversation_id": conversation_id,
            "archived_at": None,
        }
    )


async def handle_conversation_archive_all(
    someone_typeid: str,
    *,
    allowed_conversation_ids: frozenset[str] | None = None,
) -> ApiResponse:
    """Stamp ``archived_at = now()`` on every Conversation that isn't
    already archived.

    Cheap on repeat clicks because conversations with a non-null
    ``archived_at`` are skipped — no SQLite write, no WS broadcast for
    rows that are already in the target state. Returns the count of rows
    that were freshly archived.
    """
    convs = await Conversation.get_all({})
    if allowed_conversation_ids is not None:
        convs = [conv for conv in convs if conv.id in allowed_conversation_ids]
    now = datetime.now(UTC)
    archived = 0
    for conv in convs or []:
        if conv.archived_at is not None:
            continue
        conv.archived_at = now
        await conv.save(someone_typeid)
        archived += 1
    inbox.touch("conversation-archive-all")
    return ApiSuccessResponse(
        data={
            "archived": archived,
            "scanned": len(convs or []),
            "archived_at": now.isoformat(),
        }
    )


@action.post(action_name="conversation-archive", types=None)
async def conversation_archive() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        body = await request_info.get_post_data() or {}
        conv_id = (body.get("conversation_id") or "").strip()
        scope = await _optional_agent_inbox_scope(body.get("agent_id"))
        return await handle_conversation_archive(
            conv_id,
            request_info.someone_typeid,
            allowed_conversation_ids=scope.conversation_ids if scope else None,
        )
    except AgentInboxScopeError as e:
        return ApiFailResponse(message=str(e), status_code=e.status_code)
    except Exception as e:
        logger.error("[flow_message_action] conversation-archive error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed: {e}")


@action.post(action_name="conversation-unarchive", types=None)
async def conversation_unarchive() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        body = await request_info.get_post_data() or {}
        conv_id = (body.get("conversation_id") or "").strip()
        scope = await _optional_agent_inbox_scope(body.get("agent_id"))
        return await handle_conversation_unarchive(
            conv_id,
            request_info.someone_typeid,
            allowed_conversation_ids=scope.conversation_ids if scope else None,
        )
    except AgentInboxScopeError as e:
        return ApiFailResponse(message=str(e), status_code=e.status_code)
    except Exception as e:
        logger.error("[flow_message_action] conversation-unarchive error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed: {e}")


@action.post(action_name="conversation-archive-all", types=None)
async def conversation_archive_all() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        body = await request_info.get_post_data() or {}
        scope = await _optional_agent_inbox_scope(body.get("agent_id"))
        return await handle_conversation_archive_all(
            request_info.someone_typeid,
            allowed_conversation_ids=scope.conversation_ids if scope else None,
        )
    except AgentInboxScopeError as e:
        return ApiFailResponse(message=str(e), status_code=e.status_code)
    except Exception as e:
        logger.error("[flow_message_action] conversation-archive-all error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed: {e}")


async def _hard_delete_local_conversation(conv: Conversation) -> None:
    """Hard-delete a local Conversation row + its FlowMessages + jsonl.

    Shared by the prune step in ``handle_conversation_list``, the per-row
    ``handle_conversation_delete`` action, and the bulk
    ``handle_conversation_delete_archived`` loop. Best-effort — exceptions
    in any sub-step are logged but don't abort the rest of the cleanup.
    """
    if conv is None or not conv.id:
        return
    cid = conv.id
    # Cascade: delete child FlowMessages so they don't orphan in SQLite.
    try:
        from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415

        flt = QueryFilter(
            type=BuiltinEntityType.FLOW_MESSAGE.value,
            match=ExpressionNode(op=QueryOp.EQ, operands=["conversation_id", cid]),
        )
        msgs = await FlowMessage.get_all(flt)
        for fm in msgs:
            try:
                # FlowMessage.delete() also purges staging data + the
                # MessageAttachment rows (installed copies are kept).
                await fm.delete()
            except Exception as e:  # noqa: BLE001
                logger.warning("[conv-hard-delete] %s fm delete failed: %s", cid[:8], e)
    except Exception as e:  # noqa: BLE001
        logger.warning("[conv-hard-delete] %s fm list failed: %s", cid[:8], e)
    # Unlink the on-disk jsonl pointer index + parent dir if empty.
    try:
        jsonl_path = default_jsonl_path(cid)
        if jsonl_path.exists():
            jsonl_path.unlink()
        parent = jsonl_path.parent
        if parent.exists() and not any(parent.iterdir()):
            parent.rmdir()
    except Exception as e:  # noqa: BLE001
        logger.warning("[conv-hard-delete] %s jsonl unlink failed: %s", cid[:8], e)
    # Finally delete the entity row.
    try:
        await conv.delete()
    except Exception as e:  # noqa: BLE001
        logger.warning("[conv-hard-delete] %s entity delete failed: %s", cid[:8], e)


def _is_invitation_conversation(conv: Conversation) -> bool:
    """A conversation row that surfaces an invitation: it was materialized
    from a hub Invitation's embedded ``conversation`` payload AND the local
    user has not yet been added to ``participants`` (i.e. hasn't accepted).
    """
    if not conv:
        return False
    # The invitation pipeline materializes the conversation with a single
    # FlowMessage of kind='invitation'. The first-message kind isn't stored
    # on the Conversation row, so we infer the invitation state via the
    # local Invitation entity instead — there's exactly one invitation per
    # conversation in the new pipeline.
    return False


async def _classify_archived_delete(conv: Conversation, current_user_id: Optional[str]) -> str:
    """Return one of: 'decline_invitation' | 'local' | 'delete_for_all' | 'leave'.

    Inspection order:
      1. Is this conversation the target of a still-pending Invitation that
         I (the local cloud user) have not accepted? → 'decline_invitation'.
      2. Is the conv local-only (``remote=False``)? → 'local'.
      3. Am I the hub-side owner (``conv.created_by == current_user_id``)?
         → 'delete_for_all'.
      4. Otherwise → 'leave'.
    """
    # Check pending invitation targeting this conv, matched via the canonical
    # ``target_url_path`` linkage (``conversation_target_path``) that
    # ``_materialize_invitation`` persists.
    if conv.remote:
        try:
            inv = await _find_invitation_for_conversation(conv.id)
            if inv is not None and not getattr(inv, "accepted", False):
                return "decline_invitation"
        except Exception:  # noqa: BLE001
            pass
    if not conv.remote:
        return "local"
    if current_user_id and conv.created_by == current_user_id:
        return "delete_for_all"
    return "leave"


async def _current_cloud_user_id() -> Optional[str]:
    """Return the local cloud user's hub-side id, or None if not logged in."""
    try:
        from flow_sdk.cli.app_config import get_user  # noqa: PLC0415

        user = get_user() or {}
        uid = user.get("id")
        return uid if uid else None
    except Exception:  # noqa: BLE001
        return None


async def _hub_decline_invitation(invitation_id: str) -> None:
    """Class-level action — pending recipients have no entity role yet, so
    the hub registers ``decline`` as a class-action like ``pending``. We pass
    the invitation_id in the body."""
    await hub_post(
        BuiltinEntityType.INVITATION,
        {"invitation_id": invitation_id},
        action="decline",
    )


async def _find_invitation_for_conversation(conv_id: str) -> Optional["Invitation"]:
    """Return the local Invitation targeting this conversation, or None.

    Matches on the canonical ``target_url_path`` linkage
    (``conversation_target_path``) that ``_materialize_invitation`` persists
    for exactly this lookup.
    """
    from flow_sdk.builtin.invitation import (  # noqa: PLC0415
        Invitation as LocalInvitation,
    )
    from flow_sdk.builtin.invitation import (
        conversation_target_path,
    )

    target = conversation_target_path(conv_id)
    try:
        invs = await LocalInvitation.get_all({})
    except Exception:  # noqa: BLE001
        return None
    for inv in invs or []:
        if (getattr(inv, "target_url_path", None) or "").strip() == target:
            return inv
    return None


def _is_hub_target_missing(e: "HubError") -> bool:
    """Nothing left to do remotely, so a delete may proceed locally."""
    return e.is_target_missing


async def _decline_linked_invitation(conv_id: str) -> None:
    """Decline + locally remove the Invitation targeting ``conv_id``, if any.

    Used on every conversation-delete path: without the hub-side decline, a
    still-pending invitation gets re-materialized by the next
    ``invitation/pending`` sync and the just-deleted conversation reappears.
    A hub "already gone / no role" answer is a no-op; other hub errors
    propagate so the caller can surface the failure.
    """
    inv = await _find_invitation_for_conversation(conv_id)
    if inv is None:
        return
    if inv.id:
        try:
            await _hub_decline_invitation(inv.id)
        except HubError as e:
            if not _is_hub_target_missing(e):
                raise
    try:
        await inv.delete()
    except Exception as e:  # noqa: BLE001
        logger.warning("[conv-delete] local invitation delete failed conv=%s: %s", conv_id[:8], e)


async def _self_heal_gone_invitation(inv_id: str, *, context: str) -> ApiFailResponse:
    """Remove an orphaned local invitation whose hub node is gone and return the
    shared 410 ``{gone}`` signal the FE renders as "Invitation no longer valid".

    Reached from both accept and decline when the hub answers 404/target-missing:
    the local id equals the hub id, so a hub 404 means the mirror is stale.
    Best-effort local delete (clears the DB row + entity/tab caches); a failure
    still returns the gone signal so the FE drops the row.
    """
    from flow_sdk.builtin.invitation import Invitation as LocalInvitation  # noqa: PLC0415

    try:
        orphan = await LocalInvitation.get_one({"id": inv_id})
        if orphan is not None:
            await orphan.delete()
    except Exception as del_e:  # noqa: BLE001
        logger.warning("[%s] orphan local delete failed inv=%s: %s", context, inv_id[:8], del_e)
    return ApiFailResponse(
        message="Invitation no longer valid",
        status_code=410,
        data={"gone": True, "id": inv_id},
    )


async def _hub_delete_conversation(conv_id: str) -> None:
    from flow_sdk.utils.hub import hub_delete  # noqa: PLC0415

    await hub_delete(BuiltinEntityType.CONVERSATION, conv_id, action="delete")


async def _hub_leave_conversation(conv_id: str) -> None:
    await hub_post(
        BuiltinEntityType.CONVERSATION,
        {},
        entity_id=conv_id,
        action="leave",
    )


async def handle_conversation_delete_archived(
    someone_typeid: str,
    *,
    allowed_conversation_ids: frozenset[str] | None = None,
) -> ApiResponse:
    """Best-effort bulk delete: classify each archived conversation, apply
    the correct hub-side action, then hard-delete locally for items that
    succeeded hub-side — including the "hub has nothing for us" answer
    (entity gone, or no role held), which counts as success.

    Returns per-item status:
      data = {
        "deleted": [<conv_id>, ...],
        "failed":  [{"id": <conv_id>, "reason": <str>}, ...],
        "scanned": <int>,
      }
    """
    convs = await Conversation.get_all({})
    if allowed_conversation_ids is not None:
        convs = [conv for conv in convs if conv.id in allowed_conversation_ids]
    targets = [c for c in (convs or []) if c.archived_at is not None]
    cloud_user_id = await _current_cloud_user_id()

    # Pre-check: if any target needs the hub but the hub isn't reachable,
    # bail with a structured error so the UI can surface the
    # "Cloud disconnected — Reconnect first" toast (decision #4a).
    any_needs_hub = False
    for c in targets:
        kind = await _classify_archived_delete(c, cloud_user_id)
        if kind in ("delete_for_all", "leave", "decline_invitation"):
            any_needs_hub = True
            break
    if any_needs_hub and not hub_base_url():
        return ApiFailResponse(
            data={"hub_reachable": False, "auth_required": False},
            message="Cloud disconnected — reconnect to delete shared conversations.",
        )

    deleted: list[str] = []
    failed: list[dict] = []
    for conv in targets:
        try:
            mode = await _classify_archived_delete(conv, cloud_user_id)
            if mode == "decline_invitation":
                await _decline_linked_invitation(conv.id)
            elif mode in ("delete_for_all", "leave"):
                try:
                    if mode == "delete_for_all":
                        await _hub_delete_conversation(conv.id)
                    else:
                        await _hub_leave_conversation(conv.id)
                except HubError as e:
                    if not _is_hub_target_missing(e):
                        raise
                    # The hub has nothing for us here — the entity is gone or
                    # we never held a role on it (e.g. a never-accepted
                    # invitation the classifier couldn't see). The user's
                    # intent is removal, so clean up the linked invitation
                    # and proceed with the local delete.
                    await _decline_linked_invitation(conv.id)
            # The hub mutation is committed (or this is local-only). Block any
            # already-queued inbound materializer before removing the parent.
            from flow_sdk.cloud_client.hub_bridge import hub_ws_bridge  # noqa: PLC0415

            hub_ws_bridge.suppress_conversation_materialization(conv.id)
            await _hard_delete_local_conversation(conv)
            deleted.append(conv.id)
        except HubError as e:
            failed.append({"id": conv.id, "reason": f"hub {e.status_code}: {e.reason}"})
        except Exception as e:  # noqa: BLE001
            failed.append({"id": conv.id, "reason": str(e)})

    return ApiSuccessResponse(
        data={
            "deleted": deleted,
            "failed": failed,
            "scanned": len(convs or []),
        }
    )


@action.post(action_name="conversation-delete-archived", types=None)
async def conversation_delete_archived() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        body = await request_info.get_post_data() or {}
        scope = await _optional_agent_inbox_scope(body.get("agent_id"))
        return await handle_conversation_delete_archived(
            request_info.someone_typeid,
            allowed_conversation_ids=scope.conversation_ids if scope else None,
        )
    except AgentInboxScopeError as e:
        return ApiFailResponse(message=str(e), status_code=e.status_code)
    except Exception as e:
        logger.error("[flow_message_action] conversation-delete-archived error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed: {e}")


async def handle_conversation_delete(
    conversation_id: str,
    mode: str,
    someone_typeid: str,
    *,
    allowed_conversation_ids: frozenset[str] | None = None,
) -> ApiResponse:
    """Per-row delete with explicit semantics (mode in {delete_for_all, leave, local}).

    The UI picks the mode based on the user's relationship to the conversation:
      * ``delete_for_all`` — caller owns a shared conv (rule 1 cascade).
      * ``leave``          — caller is a non-owner participant (rule 3).
      * ``local``          — purely-local conv with no hub counterpart (rule 2).

    All non-``local`` modes pre-check hub reachability (decision #4a) and
    return ``{hub_reachable: false, auth_required}`` on failure so the UI
    can surface a clear toast instead of a transient error.
    """
    if mode not in {"delete_for_all", "leave", "local"}:
        return ApiFailResponse(message=f"Unknown delete mode: {mode}")
    if not conversation_id:
        return ApiFailResponse(message="conversation_id is required")
    if allowed_conversation_ids is not None and conversation_id not in allowed_conversation_ids:
        return ApiFailResponse(message="Conversation is not in this Agent inbox", status_code=404)

    conv = await Conversation.get_one({"id": conversation_id})
    if conv is None:
        return ApiFailResponse(message="Conversation not found", data={"id": conversation_id})

    if mode != "local":
        if not hub_base_url():
            return ApiFailResponse(
                data={"hub_reachable": False, "auth_required": False, "id": conversation_id},
                message="Cloud disconnected — reconnect to delete shared conversations.",
            )
        try:
            try:
                if mode == "delete_for_all":
                    await _hub_delete_conversation(conversation_id)
                else:  # mode == "leave"
                    await _hub_leave_conversation(conversation_id)
            except HubError as e:
                if not _is_hub_target_missing(e):
                    raise
                # The hub has nothing for us here — the entity is gone or we
                # never held a role on it (e.g. a never-accepted invitation).
                # The user's intent is removal, so clean up the linked
                # invitation and proceed with the local delete.
                await _decline_linked_invitation(conversation_id)
        except HubError as e:
            return ApiFailResponse(
                data={"id": conversation_id, "hub_status": e.status_code},
                message=f"Hub {e.status_code}: {e.reason}",
            )

    # The hub mutation is committed (or this is local-only). A detached hub
    # message materializer may still be queued, so establish the tombstone
    # before the local cascade removes its parent. The generic graph DELETE has
    # the same guard; the canonical conversation lifecycle must own it too.
    from flow_sdk.cloud_client.hub_bridge import hub_ws_bridge  # noqa: PLC0415

    hub_ws_bridge.suppress_conversation_materialization(conversation_id)
    await _hard_delete_local_conversation(conv)
    return ApiSuccessResponse(data={"id": conversation_id, "mode": mode})


@action.post(action_name="conversation-delete", types=None)
async def conversation_delete() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        body = await request_info.get_post_data() or {}
        conv_id = (body.get("conversation_id") or "").strip()
        mode = (body.get("mode") or "").strip()
        scope = await _optional_agent_inbox_scope(body.get("agent_id"))
        return await handle_conversation_delete(
            conv_id,
            mode,
            request_info.someone_typeid,
            allowed_conversation_ids=scope.conversation_ids if scope else None,
        )
    except AgentInboxScopeError as e:
        return ApiFailResponse(message=str(e), status_code=e.status_code)
    except Exception as e:
        logger.error("[flow_message_action] conversation-delete error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed: {e}")


async def handle_remove_message(flow_message_id: str) -> ApiResponse:
    """Delete a single FlowMessage everywhere (rule: sender OR conversation owner).

    Local entrypoint behind the ``remove-message`` action. Flow:
      * gate locally on the resolved cloud-user id == ``fm.sender_id`` OR
        == ``conv.created_by`` (owner). Purely-local conversations have no
        cloud counterpart, so the local single user always passes.
      * for shared (``remote``) conversations, pre-check hub reachability then
        call ``Conversation.remove_message`` — the hub re-enforces the gate,
        deletes the hub-side FlowMessage and fans a DELETE op to participants.
      * always purge the local existence: ``fm.destroy()`` (DB row +
        relationships + on-disk record folder) and drop the conversation
        pointer (``prune_message_pointer`` re-projects with notify so the
        initiator's open view refreshes).
    """
    from flow_sdk.fs_store.fs_record import FSRecord  # noqa: PLC0415
    from flow_sdk.utils.hub import HubError  # noqa: PLC0415

    fm_id = (flow_message_id or "").strip()
    if not fm_id:
        return ApiFailResponse(message="flow_message_id is required")

    fm = await FlowMessage.get_one({"id": fm_id})
    if fm is None:
        return ApiFailResponse(message=f"FlowMessage not found: {fm_id}", status_code=404)

    conv_id = (fm.conversation_id or "").strip()
    conv = await Conversation.get_one({"id": conv_id}) if conv_id else None

    # A purely-local conversation (no cloud counterpart, owner-less) is
    # single-user, so the gate + hub round-trip only apply to shared convs.
    if conv and getattr(conv, "remote", False):
        # Gate: deleter is the message sender OR the conversation owner. The
        # cloud user id is the authority for both. Owner = ``created_by``
        # matches (recipient-side, where the hub stamped the cloud-user id) OR
        # the caller holds role ``owner`` in the participant roster
        # (creator-side, where ``created_by`` is the local user id). The roster
        # is the hub-authoritative signal on both sides.
        cloud_user_id = await _current_cloud_user_id()
        is_sender = bool(cloud_user_id and fm.sender_id and cloud_user_id == fm.sender_id)
        is_owner = bool(
            cloud_user_id
            and (
                (conv.created_by and cloud_user_id == conv.created_by)
                or any(
                    (p or {}).get("user_id") == cloud_user_id and str((p or {}).get("role") or "").lower() == "owner"
                    for p in (conv.members or [])
                )
            )
        )
        if not (is_sender or is_owner):
            return ApiFailResponse(
                message="Only the message sender or the conversation owner can delete this message.",
                status_code=403,
            )

        # Delete for everyone via the hub (which re-enforces the gate and fans
        # the DELETE op out to all participants).
        if not hub_base_url():
            return ApiFailResponse(
                data={"hub_reachable": False, "auth_required": False, "id": fm_id},
                message="Cloud disconnected — reconnect to delete shared messages.",
            )
        try:
            await conv.remove_message(fm_id)
        except HubError as e:
            return ApiFailResponse(
                data={"id": fm_id, "hub_status": e.status_code},
                message=f"Hub {e.status_code}: {e.reason}",
            )

    # Detach the child edge BEFORE destroying the row. Membership is the edge
    # now, so pruning only the jsonl pointer would leave the message in the
    # projection — the reproject reads edges. Order matters twice over: after
    # ``destroy()`` the child no longer resolves, so ``detach_child`` would find
    # nothing to remove and announce nothing.
    if conv_id:
        try:
            conv_for_detach = await Conversation.get_one({"id": conv_id})
            if conv_for_detach is not None:
                await conv_for_detach.detach_child(fm.typeid, notify=True)
        except Exception as e:  # noqa: BLE001
            logger.warning("[remove-message] child detach failed fm=%s conv=%s: %s", fm_id, conv_id, e)

    # Purge the local existence (DB row + relationships + on-disk record folder
    # + staging data/MessageAttachment rows, via the FlowMessage lifecycle).
    try:
        await fm.destroy()
    except Exception as e:  # noqa: BLE001
        logger.warning("[remove-message] local destroy failed fm=%s: %s", fm_id, e)

    # Drop the conversation pointer + re-project (notify so the open view updates).
    if conv_id:
        rec = FSRecord(type=RecordType.CONVERSATION, id=conv_id)
        try:
            await prune_message_pointer(rec, fm_id, notify=True)
        except Exception as e:  # noqa: BLE001
            logger.warning("[remove-message] pointer prune failed fm=%s conv=%s: %s", fm_id, conv_id, e)

    return ApiSuccessResponse(data={"flow_message_id": fm_id, "conversation_id": conv_id})


@action.post(action_name="remove-message", types=["flow_message"])
async def remove_message() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        body = await request_info.get_post_data() or {}
        fm_id = (body.get("flow_message_id") or "").strip()
        # The action target id (flow_message-<id>) is the fallback when the
        # body omits the explicit field — the UI calls it on the message entity.
        if not fm_id:
            tgt = getattr(request_info, "target_entity_typeid", None)
            if tgt is not None and getattr(tgt, "id", None):
                fm_id = str(tgt.id).strip()
        return await handle_remove_message(fm_id)
    except Exception as e:
        logger.error("[flow_message_action] remove-message error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed: {e}")


async def handle_invitation_decline(
    invitation_id: str,
    someone_typeid: str,
) -> ApiResponse:
    """Decline a pending invitation hub-side AND remove the local row
    (along with the embedded Conversation + preview message that the
    new invitation pipeline materialized).
    """
    from flow_sdk.builtin.invitation import Invitation as LocalInvitation  # noqa: PLC0415
    from flow_sdk.utils.hub import HubError, hub_base_url  # noqa: PLC0415

    if not invitation_id:
        return ApiFailResponse(message="invitation_id is required")
    if not hub_base_url():
        return ApiFailResponse(
            data={"hub_reachable": False, "auth_required": False, "id": invitation_id},
            message="Cloud disconnected — reconnect to decline invitations.",
        )
    try:
        await _hub_decline_invitation(invitation_id)
    except HubError as e:
        # Hub has nothing there for us (404 / target_not_found): the local
        # invitation is an orphan. Self-heal — remove it locally and report the
        # same 410 {gone} signal accept uses, so the FE drops the row with
        # "Invitation no longer valid". Other hub errors are transient.
        if not _is_hub_target_missing(e):
            return ApiFailResponse(
                data={"id": invitation_id, "hub_status": e.status_code},
                message=f"Hub {e.status_code}: {e.reason}",
            )
        return await _self_heal_gone_invitation(invitation_id, context="invitation-decline")

    # Locate the local invitation + its target conversation (the conv id
    # is stamped into the invitation message via ``Conversation.share``).
    try:
        inv = await LocalInvitation.get_one({"id": invitation_id})
    except Exception:  # noqa: BLE001
        inv = None
    target_conv_id: Optional[str] = None
    if inv is not None:
        msg = (getattr(inv, "message", None) or "").strip()
        if msg.startswith("conversation-"):
            target_conv_id = msg.removeprefix("conversation-")
        try:
            await inv.delete()
        except Exception as e:  # noqa: BLE001
            logger.warning("[invitation-decline] local inv delete failed: %s", e)
    if target_conv_id:
        try:
            conv = await Conversation.get_one({"id": target_conv_id})
            if conv is not None:
                await _hard_delete_local_conversation(conv)
        except Exception as e:  # noqa: BLE001
            logger.warning("[invitation-decline] local conv cleanup failed: %s", e)

    return ApiSuccessResponse(data={"id": invitation_id})


@action.post(action_name="invitation-decline", types=None)
async def invitation_decline() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        body = await request_info.get_post_data() or {}
        inv_id = (body.get("invitation_id") or "").strip()
        return await handle_invitation_decline(inv_id, request_info.someone_typeid)
    except Exception as e:
        logger.error("[flow_message_action] invitation-decline error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed: {e}")


@action.post(action_name="conversation-create", types=None)
async def conversation_create() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info:
            return ApiFailResponse(message="No request info found")
        if not request_info.someone_typeid:
            return ApiFailResponse(message="No authenticated user in request context")

        body = await request_info.get_post_data() or {}
        project_id = (body.get("project_id") or "").strip()
        shared_context_entities = body.get("shared_context_entities") or []
        if not isinstance(shared_context_entities, list):
            return ApiFailResponse(message="shared_context_entities must be a list")
        # ``project_id`` is the ambient fallback; a shared entity can supply the
        # project instead, so it's required only when nothing is shared.
        if not project_id and not shared_context_entities:
            return ApiFailResponse(message="project_id is required")
        participants = body.get("participants") or []
        if not isinstance(participants, list):
            return ApiFailResponse(message="participants must be a list")
        title = (body.get("title") or "").strip() or None

        return await handle_create_project_conversation(
            project_id=project_id,
            participants=participants,
            someone_typeid=request_info.someone_typeid,
            title=title,
            shared_context_entities=shared_context_entities,
        )
    except Exception as e:
        logger.error("[flow_message_action] conversation-create error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed to create conversation: {str(e)}")


# ---------------------------------------------------------------------------
# Help-desk (support) actions
# ---------------------------------------------------------------------------


async def _hub_action(method: str, path: str, body: Optional[dict] = None, timeout: float = 10.0) -> Optional[dict]:
    """Authenticated HTTP call to a hub action; returns the parsed ApiResponse
    envelope (``{"status","message","data"}``) or ``None`` on transport failure.

    Help-desk queue/ticket actions are request/response project actions — HTTP is
    a better fit (and more robust) than the message-fanout WS bridge, which is
    reserved for the add_message fast-path. Mirrors the authed-httpx pattern in
    ``notification_action._hub_knows_conversation``."""
    try:
        import httpx  # noqa: PLC0415

        from flow_sdk.cli.auth.credentials import load_credentials  # noqa: PLC0415
        from flow_sdk.cloud_client.client import ApiConfig  # noqa: PLC0415

        creds = load_credentials()
        if not creds or not creds.api_key:
            return None
        url = ApiConfig.from_env()._get_full_url(path)
        headers = {
            "Authorization": f"Bearer {creds.api_key}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        async with httpx.AsyncClient(timeout=timeout) as h:
            r = await h.request(method, url, headers=headers, json=None if method == "GET" else (body or {}))
            return r.json()
    except Exception as e:  # noqa: BLE001
        logger.warning("[helpdesk] hub %s %s failed: %s", method, path, e)
        return None


class HelpdeskTarget(NamedTuple):
    """Which help desk a request should be routed to.

    ``project_id`` is the hub project that owns the ticket queue;
    ``portal_git_url`` is that desk's help-content repo (may be ``None`` — a
    desk can answer tickets without publishing a portal).
    """

    project_id: str
    portal_git_url: Optional[str] = None


async def _hub_default_helpdesk() -> Optional[HelpdeskTarget]:
    """The deployment's default help desk, from the hub's ``/version``.

    ``None`` when the hub is unreachable or doesn't advertise one. This is the
    terminal fallback for :func:`resolve_helpdesk` — the end of every support
    chain. See the hub's ``ensure_helpdesk_project``.
    """
    try:
        from flow_sdk.cloud_client.transport.hub_http import get_info  # noqa: PLC0415

        info = await get_info() or {}
        pid = info.get("helpdesk_project_id")
        if isinstance(pid, str) and pid.strip():
            portal = info.get("helpdesk_portal_git_url")
            return HelpdeskTarget(pid, portal if isinstance(portal, str) and portal.strip() else None)
        return None
    except Exception:  # noqa: BLE001
        return None


async def resolve_helpdesk(project_id: Optional[str] = None) -> Optional[HelpdeskTarget]:
    """Which help desk serves ``project_id`` (or the app at large when None).

    Resolution order — nearest desk wins, so support chains terminate:

    1. the Helpdesk manifest indexed from the Project root or one of its direct
       context folders
    2. the hub's default desk (``/version``)

    Deliberately NOT memoized. The pre-rename implementation cached one id for
    the process lifetime on the premise that the desk was a deployment
    constant. Once resolution depends on the calling project that premise is
    false, and a process-global memo would serve one project's desk to another.
    ``get_info`` is a single cheap GET on a cold path (ticket open / queue
    poll), so re-resolving is the correct trade.
    """
    if project_id:
        adopted = await resolve_adopted_helpdesk(project_id)
        if adopted is not None:
            return HelpdeskTarget(adopted.queue_project_id)
    return await _hub_default_helpdesk()


async def _ticket_context_typeids(project_id: Optional[str]) -> tuple[list[str], Optional[str]]:
    """``(context_typeids, session_typeid)`` for a ticket.

    The context list is what the desk needs to triage: the requester's project,
    the agent session they were running when they asked, and that session's
    transcript. The session typeid is returned separately because it is also
    the thing whose BYTES get attached — naming a transcript and shipping one
    are different jobs, and only the second gives the assignee something to
    open.

    Best-effort by design — a ticket must never fail to open because context
    could not be gathered. Returns ``([], None)`` rather than raising.

    The session is resolved as the project's most recently active
    ``AgenticProcess``, which is what "what was I doing when this went wrong"
    means from the requester's side.
    """
    out: list[str] = []
    session_typeid: Optional[str] = None
    if not project_id:
        return out, session_typeid
    try:
        from flow_sdk.builtin.project import Project  # noqa: PLC0415

        project = await Project.get_by_id(project_id)
        if project is None:
            return out, session_typeid
        out.append(str(project.typeid))

        from flow_sdk.builtin.agentic_process.agentic_process import (  # noqa: PLC0415
            AgenticProcess,
        )

        # AgenticProcess is project-FIELD scoped, not graph-scoped — a scoped
        # query returns 0 rows. Filter on the field.
        processes = await AgenticProcess.get_all({"project_id": project_id})
        latest = max(
            (p for p in processes if getattr(p, "updated_date", None)),
            key=lambda p: p.updated_date,
            default=None,
        )
        if latest is not None:
            out.append(str(latest.typeid))
            session_id = getattr(latest, "session_id", None)
            if session_id:
                session_typeid = f"claude_session-{session_id}"
                out.append(session_typeid)
    except Exception as e:  # noqa: BLE001
        logger.info("[helpdesk-start-ticket] context gather skipped: %s", e)
    return out, session_typeid


#: How much transcript rides with a ticket. Enough for an assignee to see what
#: the agent actually tried; short enough that a desk is not handed a customer's
#: entire working session. The tail, not the head — the failure is at the end.
TICKET_TRANSCRIPT_CHARS = 4000


async def _ticket_transcript_excerpt(session_typeid: Optional[str]) -> Optional[str]:
    """A readable tail of the requester's session, for the ticket body.

    A support ticket cannot carry the transcript as BYTES. The requester holds
    the ``guest`` role on someone else's desk, and that role is deliberately
    narrow — it permits ``start_guest_conversation`` and nothing else. A guest
    can read the conversation they opened but cannot list its child messages
    (the children route 401s), so there is no local message to attach a body
    to and no way to address one on the hub. The bundle path
    (``agenticProcessShareSource`` → ``upload_body``) needs both.

    Sending the text is what makes the ticket answerable inside the permissions
    that exist. The ``type_id`` attachment still travels alongside it, so once
    the assignee picks the ticket up — and both sides are participants — the
    full session can be pulled through the ordinary share path.

    Best-effort: an unreadable or missing transcript yields ``None``.
    """
    if not session_typeid or not session_typeid.startswith("claude_session-"):
        return None
    try:
        import json as _json  # noqa: PLC0415
        from pathlib import Path  # noqa: PLC0415

        from flow_sdk.builtin.claude_session import ClaudeSession  # noqa: PLC0415

        session_id = session_typeid.split("-", 1)[1]
        session = await ClaudeSession.get_by_id(session_id)
        # ``asset_ref`` IS the transcript jsonl — a session is a file-backed
        # entity whose id is the Claude session id.
        ref = getattr(session, "asset_ref", None) if session else None
        path = Path(ref) if ref else None
        if path is None or not path.is_file():
            return None

        turns: list[str] = []
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                row = _json.loads(line)
            except ValueError:
                continue
            message = row.get("message") or {}
            role = message.get("role") or row.get("type") or "?"
            content = message.get("content")
            if isinstance(content, list):
                text = " ".join(part.get("text", "") for part in content if isinstance(part, dict)).strip()
            else:
                text = str(content or "").strip()
            if text:
                turns.append(f"{role}: {text}")
        if not turns:
            return None

        excerpt = "\n".join(turns)
        if len(excerpt) > TICKET_TRANSCRIPT_CHARS:
            excerpt = "…\n" + excerpt[-TICKET_TRANSCRIPT_CHARS:]
        return excerpt
    except Exception as e:  # noqa: BLE001
        logger.info("[helpdesk-start-ticket] transcript excerpt skipped: %s", e)
        return None


@action.post(action_name="helpdesk-start-ticket", types=None)
async def helpdesk_start_ticket() -> ApiResponse:
    """Open a support ticket — a guest-authored ``helpdesk`` conversation under
    the resolved helpdesk project.

    Routes through the hub (``Project.start_guest_conversation``), then
    materializes the conversation + first message locally as a hub-mirrored
    ``kind=helpdesk`` row so it appears in the guest's UI immediately (the hub
    fanout skips the sender, so the local backend is this row's source of
    truth). Returns the new conversation id for navigation.
    """
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="No authenticated user in request context")
        someone_typeid = request_info.someone_typeid

        body = await request_info.get_post_data() or {}
        text = (body.get("text") or body.get("message") or "").strip()
        if not text:
            return ApiFailResponse(message="text is required")

        project_id = (body.get("project_id") or "").strip()
        target = await resolve_helpdesk(project_id or None)
        if not target:
            return ApiFailResponse(message="Help desk is unavailable on this hub")
        helpdesk_id = target.project_id

        # Context rides with the ticket. A desk answering for someone else's
        # project cannot triage from prose alone — "which engagement is this,
        # and what was the agent doing?" is the first question every time, and
        # a round trip to ask it is the difference between a ticket answered
        # today and one answered tomorrow.
        #
        # ``FlowMessage.context`` is a TypeId list the hub stores without
        # inspecting, so this needs nothing hub-side. Ids only: the desk is a
        # different machine and cannot read the requester's disk. Transcript
        # BYTES travel separately, through the share bundle
        # (``agenticProcessShareSource`` → ``upload_body``) — the assignee
        # pulls them once they pick the ticket up.
        hub_body: dict = {"text": text}
        ticket_context, session_typeid = await _ticket_context_typeids(project_id or None)
        if ticket_context:
            hub_body["context"] = ticket_context

        # The session rides two ways, because neither alone is enough. The
        # ``type_id`` attachment is the durable reference the assignee resolves
        # after pickup; the excerpt is what makes the ticket answerable BEFORE
        # then, since a guest cannot upload a body bundle to someone else's
        # desk (see ``_ticket_transcript_excerpt``).
        excerpt = await _ticket_transcript_excerpt(session_typeid)
        if session_typeid:
            hub_body["attachment"] = [
                # Lowercase: the wire value is the enum VALUE (``type_id``),
                # not its Python name. The hub validates strictly and rejects
                # ``TYPE_ID`` with a 400.
                {"attachment_type": "type_id", "data": session_typeid}
            ]
        if excerpt:
            hub_body["text"] = f"{text}\n\n--- agent session (last {TICKET_TRANSCRIPT_CHARS} chars) ---\n{excerpt}"

        resp = await _hub_action("POST", f"/graph/project/{helpdesk_id}/start_guest_conversation", hub_body)
        if not resp or resp.get("status") != "SUCCESS":
            msg = (resp or {}).get("message") or "hub unreachable"
            # 502, not the default 500: the failure is the UPSTREAM hub rejecting
            # or not resolving the helpdesk project (e.g. an unseeded hub
            # returns 401 "Entity project-<id> not found") — our backend is
            # healthy, so a 500 Internal Server Error misattributes it to us.
            return ApiFailResponse(message=f"Could not open support ticket: {msg}", status_code=502)
        conv_data = resp.get("data") or {}
        conv_id = conv_data.get("id")
        if not conv_id:
            return ApiFailResponse(message="Hub did not return a conversation")

        from flow_sdk.cloud_client.hub_bridge import hub_ws_bridge  # noqa: PLC0415

        hub_ws_bridge.remember_hub_conversation(conv_id)

        from flow_sdk.app.actions.materialize_flow_message import ensure_conversation_entity  # noqa: PLC0415
        from flow_sdk.builtin.conversation import ConversationKind  # noqa: PLC0415

        title = text if len(text) <= 60 else f"{text[:60].rstrip()}…"
        # Hub-owned conversation: no local project_id (mirrors how received
        # remote conversations materialize); carry the helpdesk project as the
        # remote project identity for traceability.
        await ensure_conversation_entity(
            conv_id,
            parent_typeid=None,
            remote_project_id=helpdesk_id,
            title=title,
            someone_typeid=someone_typeid,
        )

        # Pull the first (guest) message from the hub into the local store. Do
        # this BEFORE stamping kind/remote — the message sync re-materializes the
        # conversation from the hub and would otherwise clobber kind back to the
        # default. Our stamp must be the LAST write.
        try:
            await _fetch_conversation_messages(conv_id, someone_typeid)
        except Exception as e:  # noqa: BLE001
            logger.warning("[helpdesk-start-ticket] message sync failed (non-fatal): %s", e)

        conv = await Conversation.get_one({"id": conv_id})
        if conv:
            conv.kind = ConversationKind.HELPDESK
            conv.remote = True
            # Carry the hub owner VERBATIM when present; never mask a genuinely
            # null hub owner with a stale local value. Reflection keeps the
            # save from re-stamping updated_by with the local user.
            if conv_data.get("initiated_by") is not None:
                conv.created_by = conv_data["initiated_by"]
            with remote_reflection():
                await conv.save(someone_typeid, notify=False)

        return ApiSuccessResponse(
            data={
                "conversation_id": conv_id,
                "project_id": helpdesk_id,
                "context": ticket_context,
                "session": session_typeid,
                "transcript_included": bool(excerpt),
            }
        )
    except Exception as e:
        logger.error("[flow_message_action] helpdesk-start-ticket error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed to start support ticket: {str(e)}")


@action.post(action_name="conversation-pickup", types=None)
async def conversation_pickup() -> ApiResponse:
    """Staff-side: pick up (join) a helpdesk ticket so the caller starts
    receiving its messages and can reply. Proxies to the hub ``pickup`` action,
    then syncs the conversation's messages locally. Hub gates on project
    membership."""
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="No authenticated user in request context")
        someone_typeid = request_info.someone_typeid

        body = await request_info.get_post_data() or {}
        conv_id = (body.get("conversation_id") or "").strip()
        if not conv_id:
            return ApiFailResponse(message="conversation_id is required")

        resp = await _hub_action("POST", f"/graph/conversation/{conv_id}/pickup", {})
        if not resp or resp.get("status") != "SUCCESS":
            msg = (resp or {}).get("message") or "hub unreachable"
            return ApiFailResponse(message=f"Could not pick up conversation: {msg}")

        from flow_sdk.cloud_client.hub_bridge import hub_ws_bridge  # noqa: PLC0415

        hub_ws_bridge.remember_hub_conversation(conv_id)

        # Take the hub's metadata before syncing messages. Pickup used to
        # create the local row as a side effect of the message sync
        # (``ensure_conversation_entity``), which knows nothing about the hub
        # conversation and therefore left ``kind`` at its default — so a
        # support ticket materialized on the STAFF side as an ordinary
        # ``direct`` chat and the desk's queue view could not recognise it.
        # Pickup is a hub-authoritative materialization; it takes the same
        # metadata seam every other sync path uses (mirrors invitation-accept:
        # join → fetch → upsert).
        try:
            hub_conv = await _hub_action("GET", f"/graph/conversation/{conv_id}")
            data = (hub_conv or {}).get("data")
            if isinstance(data, dict) and data.get("id"):
                await _upsert_hub_conversation_metadata(data, someone_typeid)
        except Exception as e:  # noqa: BLE001
            logger.warning("[conversation-pickup] metadata sync failed (non-fatal): %s", e)

        try:
            await _fetch_conversation_messages(conv_id, someone_typeid)
        except Exception as e:  # noqa: BLE001
            logger.warning("[conversation-pickup] message sync failed (non-fatal): %s", e)
        return ApiSuccessResponse(data={"conversation_id": conv_id})
    except Exception as e:
        logger.error("[flow_message_action] conversation-pickup error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed to pick up conversation: {str(e)}")


@action.post(action_name="helpdesk-tickets-list", types=None)
async def helpdesk_tickets_list() -> ApiResponse:
    """Staff triage queue: list the helpdesk project's tickets (members-only on
    the hub). Returns the lightweight rows verbatim so the UI can render an
    "unpicked" queue — unpicked tickets don't fan out to non-participants, so
    this is the only way staff discover them. Picking one up materializes it
    locally (see ``conversation-pickup``).

    Two callers with opposite questions share this action:

    * a REQUESTER asks "which desk serves me?" — pass ``project_id`` (the
      project they are working in) and the desk is resolved from it.
    * STAFF ask "what is queued on MY desk?" — pass ``desk_project_id``, the
      hub project that owns the queue, and it is used verbatim.

    Staff need the second form because resolution only ever answers the first
    question: a desk owner's own project has no desk of its own, so resolving
    from it walks past their queue to whatever desk serves *them* (the hub's
    default), and they get "no valid access for role ['guest']" against a desk
    that isn't theirs. Their own tickets were unreachable from the app.
    """
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="No authenticated user in request context")

        body = await request_info.get_post_data() or {}
        # Explicit desk wins: the staff surface already knows which desk it is
        # rendering, and asking it to be re-derived is what broke the case.
        desk_project_id = (body.get("desk_project_id") or "").strip()
        if desk_project_id:
            helpdesk_id = desk_project_id
        else:
            project_id = (body.get("project_id") or "").strip()
            target = await resolve_helpdesk(project_id or None)
            if not target:
                return ApiFailResponse(message="Help desk is unavailable on this hub")
            helpdesk_id = target.project_id

        resp = await _hub_action("GET", f"/graph/project/{helpdesk_id}/helpdesk_conversations")
        # Propagate a hub authorization/transport failure instead of synthesizing
        # an empty success. A non-staff caller gets a FAIL envelope here ("no
        # valid access for role ['guest']"); collapsing that to {tickets: []}
        # makes "unauthorized" indistinguishable from "empty queue" — it hid a
        # real staff-UI robustness gap and defeated the helpdesk_two_client
        # skip-guard (its try/catch never fired on a non-staff hub).
        if not resp or resp.get("status") != "SUCCESS":
            msg = (resp or {}).get("message") or "hub unreachable"
            # 502: upstream hub rejected/could not resolve the helpdesk queue
            # (non-staff caller → "no valid access"), not an internal error here.
            return ApiFailResponse(message=f"Could not list help desk tickets: {msg}", status_code=502)
        rows = resp.get("data") or []
        if not isinstance(rows, list):
            rows = []
        return ApiSuccessResponse(data={"tickets": rows, "project_id": helpdesk_id})
    except Exception as e:
        logger.error("[flow_message_action] helpdesk-tickets-list error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed to list help desk tickets: {str(e)}")


# ---------------------------------------------------------------------------
# Inbox actions
# ---------------------------------------------------------------------------


def _last_fetch_path() -> Path:
    return get_instance_settings().inbox_last_fetch_path


def _load_last_fetch() -> Optional[str]:
    """Return ISO timestamp of last successful hub fetch, or None."""
    try:
        if _last_fetch_path().exists():
            return _json.loads(_last_fetch_path().read_text()).get("last_fetch")
    except Exception:
        pass
    return None


def _save_last_fetch(ts: str) -> None:
    _last_fetch_path().parent.mkdir(parents=True, exist_ok=True)
    _last_fetch_path().write_text(_json.dumps({"last_fetch": ts}))


def _bundle_download_lock(fm_id: str) -> asyncio.Lock:
    loop = asyncio.get_running_loop()
    key = (loop, fm_id)
    lock = _BUNDLE_DOWNLOAD_LOCKS.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _BUNDLE_DOWNLOAD_LOCKS[key] = lock
    return lock


async def _download_and_unpack_bundle(
    fm_id: str,
    attachment_filename: str,
    *,
    body_status: "str | BodyStatus | None" = None,
    overwrite: bool = False,
    raise_on_conflict: bool = False,
    on_progress=None,
    hub_updated: str | None = None,
) -> bool:
    """Download the .flowmsg bundle from the hub and unpack it locally.

    Returns True if the bundle was successfully unpacked, False otherwise.

    ``body_status`` — the hub-side body lifecycle for this message. This is the
    SINGLE backend gate: when it's anything other than READY there is no bundle
    on the hub to pull (``na`` = none was ever uploaded, ``uploading`` = not yet
    landed), so we skip the GET entirely rather than 404. Every implicit caller
    (open / inbox-open / conversation-sync / invitation-accept / catch-up / the
    eager-pull bridge) forwards what it already read from the hub payload; the
    explicit ``download_body`` path forwards its own READY status. ``None`` means
    "caller did not supply a status" and proceeds unchanged (back-compat).

    File-backed assets in the bundle are STAGED under the message's record-data
    dir and surfaced as MessageAttachment rows (``unpack_bundle``) — no project
    mapping is needed to download; installing is a separate explicit action.

    ``on_progress`` — optional async callback fired as download bytes land;
    when set the hub GET is streamed instead of buffered whole.
    """
    async with _bundle_download_lock(fm_id):
        return await _download_and_unpack_bundle_locked(
            fm_id,
            attachment_filename,
            body_status=body_status,
            overwrite=overwrite,
            raise_on_conflict=raise_on_conflict,
            on_progress=on_progress,
            hub_updated=hub_updated,
        )


async def _download_and_unpack_bundle_locked(
    fm_id: str,
    attachment_filename: str,
    *,
    body_status: "str | BodyStatus | None" = None,
    overwrite: bool = False,
    raise_on_conflict: bool = False,
    on_progress=None,
    hub_updated: str | None = None,
) -> bool:
    from flow_sdk.builtin.flow_message_bundle import (
        FlowMessageExistsError,
        unpack_bundle,
    )

    if body_status is not None:
        bs = _body_status_value(body_status)
        if bs != BodyStatus.READY.value:
            logger.debug(
                "[bundle] skip download fm=%s — body_status=%s (no bundle to pull)",
                fm_id,
                bs,
            )
            return False
    bundle_bytes = await hub_get(
        BuiltinEntityType.FLOW_MESSAGE,
        fm_id,
        "fs",
        f"download/{attachment_filename}",
        raw=True,
        on_progress=on_progress,
    )
    if not bundle_bytes:
        logger.warning("[bundle] download returned no bytes for fm=%s", fm_id)
        return False
    local_user = await User.get_one({"uname": "local"})
    local_user_id = local_user.id if local_user else ""
    with tempfile.NamedTemporaryFile(suffix=".flowmsg", delete=False) as tmp:
        tmp_path = Path(tmp.name)
        tmp.write(bundle_bytes)
    try:
        await unpack_bundle(tmp_path, local_user_id, overwrite=overwrite, hub_updated=hub_updated)
        # Bundle bytes are on disk now. The FM's ``attachment[].local_path``
        # is computed lazily by the model serializer from disk state, so the
        # cached browser entity still reads ``local_path=null`` from the
        # earlier WS create. Fan a fresh UPDATE so subscribers re-render with
        # the populated path — without this, image attachments stay as a
        # generic file chip until a manual refresh re-fetches the FM.
        try:
            refreshed = await FlowMessage.get_one({"id": fm_id})
            if refreshed:
                # Hub-authoritative body_status. The row was just materialized
                # from the BUNDLE header, whose body_status is the sender's value
                # AT PACK TIME — still UPLOADING, because ``upload_body`` packs the
                # .flowmsg BEFORE flipping READY (and ``merge_hub_payload`` treats
                # body_status as local-only state, so the hub's READY never lands
                # via the metadata sync). We only reach this success path when the
                # hub advertised body_status=READY (the gate above) and the body is
                # now on disk — so the row IS downloadable. Stamp READY so the
                # receiver reflects that instead of the stale pack-time UPLOADING.
                target_bs = _body_status_value(body_status) or BodyStatus.READY.value
                current_bs = _body_status_value(refreshed.body_status)
                if current_bs != target_bs:
                    refreshed.body_status = BodyStatus(target_bs)
                    await refreshed.save(notify=False)
                await refreshed.notify_updated()
        except Exception as nerr:
            logger.warning("[bundle] post-unpack notify failed fm=%s: %s", fm_id, nerr)
        return True
    except FlowMessageExistsError:
        # A GENUINE collision: a different asset already occupies the receiver's
        # target path (byte-identical re-receives are now no-ops in
        # ``_restore_file_backed_entry`` and never reach here). This is NOT
        # success — swallowing it as True was the bug that silently dropped the
        # shared asset and left the receiver pointed at their own pre-existing
        # one. The explicit ``download_body`` path re-raises so the caller can
        # surface "asset already exists — overwrite?" and retry with
        # overwrite=True; implicit auto-materialize callers log + report failure
        # (False) instead of crashing a background sync.
        if raise_on_conflict:
            raise
        logger.warning(
            "[bundle] unpack conflict fm=%s — asset already exists at target; "
            "not materialized (retry with overwrite to replace)",
            fm_id,
        )
        return False
    except ValueError as e:
        # Legacy bundles (pre-header.json) raise "Invalid .flowmsg: missing
        # header.json". Per the no-legacy-support rule, drop them silently
        # rather than logging a stack trace.
        if "missing header.json" in str(e):
            return False
        logger.error("[bundle] unpack failed fm=%s: %s", fm_id, e, exc_info=True)
        return False
    except Exception as e:
        logger.error("[bundle] unpack failed fm=%s: %s", fm_id, e, exc_info=True)
        return False
    finally:
        tmp_path.unlink(missing_ok=True)


async def handle_inbox_list(*, scope: AgentInboxScope | None = None) -> ApiResponse:
    """Return non-archived received FlowMessages whose Conversation exists locally, newest first.

    FMs whose ``conversation_id`` does not resolve to a locally-known Conversation
    are filtered out so the sidebar badge stays aligned with what InboxView can
    actually render (which iterates Conversation entities). Without this gate the
    badge counted orphan FMs the user had no way to open or dismiss.
    """
    from flow_sdk.db.drivers.query import QueryFilter

    # Self-sent exclusion must check BOTH the cloud and local user ids —
    # sends stamp the cloud id when logged in, the local id otherwise.
    # Comparing against the local id alone let cloud-stamped self-sends
    # through, inflating the sidebar badge on every message the user sent.
    self_ids = await User.self_ids()
    flt = QueryFilter(type=BuiltinEntityType.FLOW_MESSAGE.value)
    all_messages = await FlowMessage.get_all(flt)
    conv_flt = QueryFilter(type=BuiltinEntityType.CONVERSATION.value)
    known_conv_ids = {c.id for c in await Conversation.get_all(conv_flt)}
    messages = [
        m
        for m in all_messages
        if not m.is_archived
        and m.sender_id not in self_ids
        and m.conversation_id in known_conv_ids
        and (scope is None or m.id in scope.flow_message_ids)
    ]
    messages.sort(key=lambda m: m.created_date or "", reverse=True)
    return ApiSuccessResponse(data=[m.model_dump(mode="json") for m in messages])


@action.get(action_name="inbox-list", types=None)
async def inbox_list() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        agent_id = request_info.request.query_params.get("agent_id") if request_info else None
        scope = await _optional_agent_inbox_scope(agent_id)
        return await handle_inbox_list(scope=scope)
    except AgentInboxScopeError as e:
        return ApiFailResponse(message=str(e), status_code=e.status_code)
    except Exception as e:
        logger.error("[flow_message_action] inbox-list error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed to list inbox: {str(e)}")


async def _fetch_raw_messages_from_hub(since: str | None) -> list[dict] | None:
    """Call hub for FlowMessages newer than `since`.

    Returns the list of raw message dicts, or None if the hub is unavailable.
    """
    params: dict = {"since": since} if since else {}
    result = await hub_get(BuiltinEntityType.FLOW_MESSAGE, params=params)
    if result is None:
        return None
    return result if isinstance(result, list) else []


async def _process_single_hub_message(raw: dict) -> str | None:
    """Download and unpack the .flowmsg bundle for one hub FlowMessage.

    Returns the fm_id if the bundle was processed (or was already materialized),
    or None if the message was skipped or the download/unpack failed.

    Two paths:
      1. ``attachment_filename`` set → standard bundle download + unpack.
      2. No bundle (text-only or TYPE_ID-only attachments) → materialise the
         FlowMessage row directly from the hub payload so the conversation
         view can render it. Older versions skipped these entirely, which
         dropped every hub message from the sender's own catch-up (their
         locally-sent messages never produce a bundle) and every pure-text
         reply from a peer.
    """
    fm_id = (raw.get("id") or "").strip()
    if not fm_id:
        return None
    existing = await FlowMessage.get_one({"id": fm_id})
    # Body first, metadata second — and the two are INDEPENDENT. The body
    # check must not be keyed on row existence: a row materialized while the
    # sender was still uploading (bridge CREATE with body_status=uploading)
    # would otherwise never auto-download its bundle on any later pass,
    # leaving every bundled entity (task / spec / transcript) unmaterialized
    # until a manual click. Pull whenever the hub advertises a bundle that
    # isn't fully on disk yet — ``_download_and_unpack_bundle`` gates on
    # body_status=READY itself, and ``unpack_bundle`` is idempotent for
    # re-unpacks (existing rows merge, attachments fill in).
    attachment_filename = (raw.get("attachment_filename") or "").strip()
    if attachment_filename:
        downloaded = existing is not None and existing.is_body_downloaded()
        if not downloaded:
            success = await _download_and_unpack_bundle(
                fm_id,
                attachment_filename,
                body_status=raw.get("body_status"),
                # The hub's own ``updated_date`` — the delivery clock the inbox
                # sorts on. Handing it to the unpack means a legacy bundle's row
                # is born with the right recency instead of being stamped with
                # the send-time and corrected a beat later, which is what made
                # conversations dive ~10 positions and snap back.
                hub_updated=raw.get("updated_date"),
            )
            if success:
                # Unpack owns the durable row and may have changed local-only
                # fields (notably stamping body_status=READY). Refresh before
                # the metadata merge below: reusing the pre-download object
                # would preserve its stale HUB_WRITE values and overwrite the
                # freshly unpacked state.
                existing = await FlowMessage.get_one({"id": fm_id})
                if existing is None:
                    # A no-row success means unpack materialized the message;
                    # there is no separate header write left to perform.
                    return fm_id
            # Download failed (body still uploading, a transient hub error, or —
            # the receiver pre-accept case — the recipient can't pull the bundle
            # body yet). Do NOT return empty: fall through to materialize the FM
            # HEADER from the hub payload (metadata only, no body), exactly like
            # the bundle-less/text branch below. Without this an artifact- or
            # git-share message's latest FlowMessage never resolves locally
            # pre-body, so the inbox's latest-pointer gate hides the whole
            # invitation row and previews/ordering break — while a plain text
            # message (no attachment_filename) materialized its header fine. The
            # body stays un-downloaded (is_body_downloaded()=False), so the next
            # sync pass re-attempts the bundle through this same branch: the
            # download gate above is keyed on body-presence, not row existence.
        hub_body_status = _body_status_value(raw.get("body_status"))
        if existing is not None and hub_body_status == BodyStatus.READY.value:
            local_body_status = _body_status_value(existing.body_status)
            if existing.is_body_downloaded() and local_body_status != BodyStatus.READY.value:
                # READY is monotonic once the receiver has the body. This also
                # heals rows left at pack-time UPLOADING after a missed bridge
                # UPDATE; never apply the inverse downgrade from stale hub data.
                existing.body_status = BodyStatus.READY
                if not FlowMessage.is_stale(existing, raw):
                    await existing.save(notify=False)
                    await existing.notify_updated()
                    return fm_id
    # Birth-time repair, AHEAD of the staleness gate — the same rule Conversation
    # applies (``_upsert_hub_conversation_metadata``). A message re-materialized
    # from a bundle that carried no send-time is stamped ``now()``, which makes it
    # look NEWER than the hub, so ``is_stale`` is False and the gate below returns
    # before any merge could fix it: the wrong value defends itself. Adopting here
    # is idempotent, so converged rows write nothing.
    if adopt_hub_created_date(existing, raw):
        with remote_reflection():
            await existing.save(notify=False)
    if existing is not None and not FlowMessage.is_stale(existing, raw):
        # Metadata current (body handled above).
        return fm_id
    # Bundle-less: persist the FM payload as-is, then append the pointer to
    # the conversation's message_ids JSON projection. We DO NOT route through
    # materialize_flow_message / _append_message_to_conversation here —
    # those are the local-send path which owns id allocation and would mint
    # a fresh FM with a new UUID if the upsert lookup misses for any reason
    # (we saw it produce duplicate rows for every hub message). The
    # catch-up contract is the opposite: the hub-side id is authoritative
    # and must round-trip unchanged into both the entities table AND the
    # conv's pointer list.
    try:
        if existing is not None:
            # Stale existing row → LWW refresh: pull hub-owned fields, preserve
            # local-only state (body_status/is_read/...), carry hub updated_date.
            payload = FlowMessage.merge_hub_payload(existing, raw)
            payload["remote"] = True
        else:
            payload = {**raw, "remote": True}
        # Local parentage. The hub has no ``parent_type_id`` on FlowMessage (only
        # its Comment declares one), so a hub payload never carries it and
        # ``merge_hub_payload`` — which restores only PRIVATE / HUB_WRITE fields —
        # would drop ours on every LWW refresh. Rather than reclassify the field
        # globally (it is SHARED, and the hub-child path deliberately lets a
        # payload's own value win), write it unconditionally: it is DERIVED from
        # the conversation we are syncing, so re-deriving it each pass is both
        # cheap and self-healing.
        _conv_id = (raw.get("conversation_id") or "").strip()
        if _conv_id:
            payload["parent_type_id"] = f"{Conversation.get_type()}-{_conv_id}"
        fm = FlowMessage.model_validate(payload)
        await fm.save()
    except Exception as e:  # noqa: BLE001
        logger.warning("[fm-process] bundle-less fm=%s save failed: %s", fm_id[:8], e)
        return None
    conv_id = (raw.get("conversation_id") or "").strip()
    if conv_id:
        # Set before the edge block so the announcement below is well-defined
        # even if that block raises (it is caught and logged, not fatal).
        conv_for_edge = None
        announce_child = False
        try:
            # The message IS a child of the conversation — make that a real local
            # edge, the way the hub already models it (``Conversation.add_child``
            # in ``add_message``).
            #
            # notify=True, and this is THE announcement for a synced message.
            # It cannot be deferred to the reconcile's projection write: that
            # writer only announces when it detects a change, and this loop has
            # already made the change — the exact swallow that let a message land
            # in SQLite with the open conversation never told. Riding the edge
            # instead of the projection is the whole point of modelling messages
            # as children.
            #
            # Volume is bounded by the new-edge guard: only a genuinely new edge
            # emits, so the every-sync re-convergence passes are silent and a
            # backlog of N new messages costs N frames — the same order as the N
            # flow_message CREATEs that already fire alongside them.
            conv_for_edge = await Conversation.get_one({"id": conv_id})
            if conv_for_edge is not None:
                # Attach SILENTLY here and announce after the projection below.
                # Announcing at attach time is a race the client always loses:
                # its handler re-reads the conversation the moment the frame
                # lands, but ``message_ids``/``message_count`` are still the
                # pre-arrival values until the projection write further down —
                # so the refetch returns a row without this message, and the
                # projection write is silent, so nobody ever corrects it. That
                # is the "message synced but the open view never updated"
                # report, reproduced live: the client's refetch fired in the
                # same second as the announcement and came back stale.
                announce_child = not await conv_for_edge._has_child_edge(fm)
                await conv_for_edge.attach_child(fm, notify=False)
        except Exception as e:  # noqa: BLE001
            logger.warning("[fm-process] child edge conv=%s fm=%s failed: %s", conv_id[:8], fm_id[:8], e)
        try:
            # Canonical write path for the message_ids / message_count
            # projection — same pattern materialize_flow_message uses on
            # the local-send side. We write the pointer to the on-disk
            # conversation.jsonl and let ConversationRecord.sync_to_db
            # bump the projection on the Conversation entity (direct
            # writes are blocked by Conversation.__setattr__'s projection
            # guard at conversation.py:252).
            rec = from_jsonl(
                default_jsonl_path(conv_id),
                parent_id="",
                record_id=conv_id,
                parent_type=RecordType.PROJECT,
            )
            existing_ids = {p.id for p in message_pointers(rec)}
            if fm_id not in existing_ids:
                ts = raw.get("created_date") or ""
                append_message_pointer(rec, fm_id, ts)
                await rec.sync_to_db(notify=False)
                # notify=False — and it stays correct, unlike before. The
                # announcement now rides the CHILD EDGE, not this projection
                # write, so suppressing it here no longer loses the event. The
                # reconcile announces the conversation once at the end of the
                # batch.
                await project_pointers_to_entity(rec, notify=False)
                # NOW the parent is worth re-reading: the projection carries
                # this message. Announcing here rather than at attach time is
                # what makes the client's refetch return the new message.
                if announce_child and conv_for_edge is not None:
                    from flow_sdk.api.api_types.messages import OperationType  # noqa: PLC0415

                    await conv_for_edge.emit_child_op(fm, OperationType.CHILD_CREATED)
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "[fm-process] pointer-append for conv=%s fm=%s failed: %s",
                conv_id[:8],
                fm_id[:8],
                e,
            )
    return fm_id


async def handle_inbox_fetch(someone_typeid: str) -> ApiResponse:
    """**Deprecated** — prefer ``conversation-list``.

    Still wired up for the in-process ``notification_scanner`` background
    sweep, which relies on the legacy ``{created, ids}`` return shape. New
    UI call sites should go through ``conversation-list`` instead, which
    fans out per-conversation bundle fetches in the background and returns
    the merged list inline.
    """
    since = _load_last_fetch()
    fetch_started = datetime.now(UTC).isoformat()

    raw_messages = await _fetch_raw_messages_from_hub(since)
    if raw_messages is None:
        return ApiFailResponse(message="Hub unavailable or not configured")

    created_ids: list[str] = []
    for raw in raw_messages:
        try:
            processed_id = await _process_single_hub_message(raw)
            if processed_id:
                created_ids.append(processed_id)
        except Exception as e:
            logger.warning("[inbox-fetch] failed to process fm=%s: %s", (raw.get("id") or "?"), e)

    _save_last_fetch(fetch_started)
    return ApiSuccessResponse(data={"created": len(created_ids), "ids": created_ids})


async def handle_inbox_open(fm_id: str) -> ApiResponse:
    """Materialise the task for a FlowMessage and return {task_id, conversation_id}."""

    # Prefer local FM (reply messages are local-only); hub is fallback for inbox messages.
    local_fm = await FlowMessage.get_one({"id": fm_id})
    hub_updated = None
    if local_fm:
        attachment_filename = (local_fm.attachment_filename or "").strip()
        body_status = local_fm.body_status
        raw_context = [str(c) for c in (local_fm.shared_context_entities or [])]
    else:
        hub_data = await hub_get(BuiltinEntityType.FLOW_MESSAGE, fm_id)
        attachment_filename = ((hub_data or {}).get("attachment_filename") or "").strip()
        body_status = (hub_data or {}).get("body_status")
        hub_updated = (hub_data or {}).get("updated_date")
        # Tolerate both new and legacy hub field names during transition.
        raw_context = (hub_data or {}).get("shared_context_entities") or (hub_data or {}).get("context_entities") or []

    task_id = None
    conv_id = None
    for c in raw_context:
        try:
            tid = TypeId(c)
            if tid.type == BuiltinEntityType.TASK.value:
                task_id = tid.id
            elif tid.type == BuiltinEntityType.CONVERSATION.value:
                conv_id = tid.id
        except Exception:
            pass

    needs_task_bundle = bool(task_id) and not await Task.get_one({"id": task_id})
    needs_fm_bundle = local_fm is None
    if attachment_filename and (needs_task_bundle or needs_fm_bundle):
        await _download_and_unpack_bundle(fm_id, attachment_filename, body_status=body_status, hub_updated=hub_updated)

    return ApiSuccessResponse(data={"task_id": task_id, "conversation_id": conv_id})


@action.get(action_name="inbox-open", types=[BuiltinEntityType.FLOW_MESSAGE.value])
async def inbox_open() -> ApiResponse:
    """Materialize the task referenced by a FlowMessage (downloads bundle if needed)."""
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No request info found", status_code=400)
        return await handle_inbox_open(str(request_info.target_entity_typeid.id))
    except Exception as e:
        logger.error("[flow_message_action] inbox-open error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Open failed: {str(e)}")


@action.post(action_name="inbox-fetch", types=None)
async def inbox_fetch() -> ApiResponse:
    """Fetch new FlowMessages from hub since last check."""
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        return await handle_inbox_fetch(request_info.someone_typeid)
    except Exception as e:
        logger.error("[flow_message_action] inbox-fetch error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Fetch failed: {str(e)}")


async def handle_inbox_update(fm_id: str, patch: dict, someone_typeid: str) -> ApiResponse:
    """Apply is_read / is_archived patch to a single FlowMessage."""
    fm = await FlowMessage.get_one({"id": fm_id})
    if not fm:
        return ApiFailResponse(message=f"FlowMessage not found: {fm_id}", status_code=404)
    if "is_read" in patch:
        fm.is_read = bool(patch["is_read"])
    if "is_archived" in patch:
        fm.is_archived = bool(patch["is_archived"])
    await fm.save(someone_typeid)
    inbox.touch("inbox-update")
    return ApiSuccessResponse(data={"id": fm_id, "is_read": fm.is_read, "is_archived": fm.is_archived})


@action.post(action_name="inbox-search", types=None)
async def inbox_search() -> ApiResponse:
    """Full-inbox body search → conversation ids. Body: ``{"q": "<substring>"}``.

    Two lanes because bodies live in two places under the reference model:
    a channel message's text is on its SourceItem (the FlowMessage row is a
    blank reference), a hub-native message's is on the row. Reference rows
    can't false-match the second query — their stored ``text`` is ``""``.
    Substring (`$LIKE`) on both lanes, matching the search this replaces.
    """
    try:
        request_info = get_current_request_info()
        if not request_info:
            return ApiFailResponse(message="No request info")
        body = await request_info.get_post_data() or {}
        scope = await _optional_agent_inbox_scope(body.get("agent_id"))
        needle = str(body.get("q") or "").strip()
        if not needle:
            return ApiSuccessResponse(data={"conversation_ids": []})
        like = f"%{needle}%"

        import asyncio  # noqa: PLC0415

        from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415
        from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415

        # The two lanes are independent — run them together.
        items, native = await asyncio.gather(
            SourceItem.get_all(
                QueryFilter(
                    match=ExpressionNode(
                        op=QueryOp.OR,
                        operands=[
                            ExpressionNode(op=QueryOp.LIKE, operands=["body", like]),
                            ExpressionNode(op=QueryOp.LIKE, operands=["name", like]),
                        ],
                    )
                )
            ),
            FlowMessage.get_all(
                QueryFilter(match=ExpressionNode(op=QueryOp.LIKE, operands=["text", like])),
                hydrate=False,
            ),
        )
        conversation_ids: set[str] = {str(m.conversation_id) for m in native if m.conversation_id}
        if items:
            refs = await FlowMessage.get_all(
                QueryFilter(
                    match=ExpressionNode(
                        op=QueryOp.IN,
                        operands=["source_item_id", [str(i.id) for i in items]],
                    )
                ),
                hydrate=False,
            )
            conversation_ids |= {str(m.conversation_id) for m in refs if m.conversation_id}
        if scope is not None:
            conversation_ids &= scope.conversation_ids
        return ApiSuccessResponse(data={"conversation_ids": sorted(conversation_ids)})
    except AgentInboxScopeError as e:
        return ApiFailResponse(message=str(e), status_code=e.status_code)
    except Exception as e:
        logger.error("[flow_message_action] inbox-search error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Search failed: {str(e)}")


@action.post(action_name="inbox-update", types=[BuiltinEntityType.FLOW_MESSAGE.value])
async def inbox_update() -> ApiResponse:
    """Update is_read / is_archived on a single FlowMessage."""
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No target entity")
        if not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        fm_id = str(request_info.target_entity_typeid.id)
        patch = await request_info.get_post_data() or {}
        scope = await _optional_agent_inbox_scope(patch.pop("agent_id", None))
        if scope is not None:
            scope.require_message(fm_id)
        return await handle_inbox_update(fm_id, patch, request_info.someone_typeid)
    except AgentInboxScopeError as e:
        return ApiFailResponse(message=str(e), status_code=e.status_code)
    except Exception as e:
        logger.error("[flow_message_action] inbox-update error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Update failed: {str(e)}")


@action.post(action_name="mark_received", types=[BuiltinEntityType.FLOW_MESSAGE.value])
async def mark_received_action() -> ApiResponse:
    """UI-side read-ack: forwards the batch to the hub via the WS bridge.

    Body: ``{flow_message_ids: list[str]}``. The hub honors monotonicity +
    sender-skip server-side, so re-acking already-received or own-sent
    messages is a cheap no-op. Returns the hub's ``{updated, skipped}``
    payload unchanged when the bridge is verified, or a graceful no-op
    when the hub WS is offline.
    """
    try:
        request_info = get_current_request_info()
        if not request_info:
            return ApiFailResponse(message="No request info")
        body = await request_info.get_post_data() or {}
        ids = body.get("flow_message_ids") or []
        if not isinstance(ids, list) or not all(isinstance(x, str) for x in ids):
            return ApiFailResponse(message="flow_message_ids must be a list of strings", status_code=400)
        if not ids:
            return ApiSuccessResponse(data={"updated": [], "skipped": []})

        from flow_sdk.cloud_client.hub_bridge import hub_ws_bridge
        from flow_sdk.cloud_client.ws_client import hub_ws_manager

        if not hub_ws_manager.is_connected:
            # Bridge not connected — degrade gracefully. The next reconnect's
            # catch-up cycle will re-emit acks for any unprocessed messages.
            return ApiSuccessResponse(
                data={"updated": [], "skipped": [{"id": i, "reason": "hub_ws_offline"} for i in ids]}
            )

        result = await hub_ws_bridge.mark_received(flow_message_ids=ids, timeout=5.0)
        # Hub returns the raw ApiResponse shape: {"status": "...", "data": {...}}
        if isinstance(result, dict) and "data" in result and isinstance(result["data"], dict):
            return ApiSuccessResponse(data=result["data"])
        return ApiSuccessResponse(data=result if isinstance(result, dict) else {})
    except Exception as e:
        logger.error("[flow_message_action] mark_received error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"mark_received failed: {str(e)}")


async def handle_send_draft(fm_id: str, someone_typeid: str) -> ApiResponse:
    """Promote a draft FlowMessage to a real reply.

    1. Validate `is_draft=True`.
    2. Append a pointer to `conversation.jsonl` and bump
       `Conversation.message_ids` / `message_count`.
    3. Flip `is_draft=False`; save.
    4. Notify the UI; the hub-side header is created by
       ``_send_conversation_message_header`` when the conversation is remote.
    """
    from flow_sdk.app.actions.notification_action import (
        _append_message_to_conversation,
        _notify_ui_conversation_updated,
        _send_conversation_message_header,
    )
    from flow_sdk.cli.auth.hub_login import is_logged_in

    fm = await FlowMessage.get_one({"id": fm_id})
    if not fm:
        return ApiFailResponse(message=f"FlowMessage not found: {fm_id}", status_code=404)
    if not fm.is_draft:
        return ApiFailResponse(message="FlowMessage is not a draft")
    if not fm.conversation_id:
        return ApiFailResponse(message="Draft has no conversation_id")

    conv = await Conversation.get_one({"id": fm.conversation_id})
    if not conv:
        return ApiFailResponse(message=f"Conversation not found: {fm.conversation_id}")

    fm.is_draft = False

    # For remote conversations, attempt the hub send BEFORE committing any
    # local state. ``_send_conversation_message_header`` returns False on
    # any failure; in that case we abort cleanly — the FM row stays as a
    # draft in DB (the in-memory ``is_draft=False`` is discarded), no
    # pointer is appended, and the user can retry. This prevents the
    # phantom "local says sent, hub doesn't know" state and avoids
    # orphaning a pointer to a still-draft row.
    is_remote_send = bool(getattr(conv, "remote", False)) and is_logged_in()
    if is_remote_send and fm.has_body():
        # A body-bearing draft (a session reply carries its prompt_completion
        # attachment + the session carrier) must announce UPLOADING so the hub
        # gates receivers until the bundle lands — exactly as a fresh send does.
        from flow_sdk.builtin.flow_message import BodyStatus  # noqa: PLC0415

        fm.body_status = BodyStatus.UPLOADING
    if is_remote_send:
        if not await _send_conversation_message_header(conv, fm):
            return ApiFailResponse(
                message="Hub send failed; draft preserved for retry",
                status_code=503,
            )
        # Hub confirmed. Mark the local row as a hub mirror so re-sync
        # treats it as a refreshable counterpart (same as received messages).
        fm.remote = True

    # Persist the finalised FM (is_draft=False, possibly remote=True) BEFORE
    # appending the pointer, so the pointer projection sees the sent state
    # instead of the still-draft state.
    fm = await fm.save(someone_typeid)

    conv = await _append_message_to_conversation(
        conv=conv,
        fm_id=fm.id,
        someone_typeid=someone_typeid,
    )

    _notify_ui_conversation_updated(conv.id, "", fm.id)

    if is_remote_send and getattr(fm, "body_status", None) == "uploading":
        from flow_sdk.app.actions.notification_action import _upload_body_and_finalize  # noqa: PLC0415

        asyncio.create_task(_upload_body_and_finalize(fm, conv.id))

    # A drafted STARTING prompt sat at DRAFT on the sender's session row;
    # sending it is the request for access.
    sid = getattr(fm, "remote_worker_session_id", None)
    if sid:
        from flow_sdk.builtin.remote_worker_session import (  # noqa: PLC0415
            RemoteWorkerSession,
            RemoteWorkerSessionStatus,
        )

        session = await RemoteWorkerSession.resolve_state(sid)
        if session is not None and session.status == RemoteWorkerSessionStatus.DRAFT:
            session.mark_activity(RemoteWorkerSessionStatus.PENDING)
            await session.save(someone_typeid)

    return ApiSuccessResponse(
        data={
            "flow_message_id": fm.id,
            "conversation_id": conv.id,
            "message_count": conv.message_count,
        }
    )


@action.post(action_name="send-draft", types=[BuiltinEntityType.FLOW_MESSAGE.value])
async def send_draft() -> ApiResponse:
    """Promote a draft FlowMessage to a real reply (jsonl pointer + hub push)."""
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No request info found")
        if not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        from flow_sdk.cli.auth.hub_login import is_logged_in

        if not is_logged_in():
            return ApiFailResponse(message="Cloud login required to send messages")
        return await handle_send_draft(
            fm_id=str(request_info.target_entity_typeid.id),
            someone_typeid=request_info.someone_typeid,
        )
    except Exception as e:
        logger.error("[flow_message_action] send-draft error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Send draft failed: {str(e)}")


async def handle_inbox_bulk_update(
    patch: dict,
    someone_typeid: str,
    *,
    allowed_flow_message_ids: frozenset[str] | None = None,
) -> ApiResponse:
    """Apply is_read / is_archived patch to all FlowMessages."""
    from flow_sdk.db.drivers.query import QueryFilter

    flt = QueryFilter(type=BuiltinEntityType.FLOW_MESSAGE.value)
    messages = await FlowMessage.get_all(flt)
    if allowed_flow_message_ids is not None:
        messages = [message for message in messages if message.id in allowed_flow_message_ids]
    count = 0
    for fm in messages:
        changed = False
        if "is_read" in patch:
            fm.is_read = bool(patch["is_read"])
            changed = True
        if "is_archived" in patch:
            fm.is_archived = bool(patch["is_archived"])
            changed = True
        if changed:
            await fm.save(someone_typeid)
            count += 1
    inbox.touch("inbox-bulk-update")
    return ApiSuccessResponse(data={"updated": count})


@action.post(action_name="inbox-bulk-update", types=None)
async def inbox_bulk_update() -> ApiResponse:
    """Bulk update is_read / is_archived across all FlowMessages."""
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        patch = await request_info.get_post_data() or {}
        scope = await _optional_agent_inbox_scope(patch.pop("agent_id", None))
        return await handle_inbox_bulk_update(
            patch,
            request_info.someone_typeid,
            allowed_flow_message_ids=scope.flow_message_ids if scope else None,
        )
    except AgentInboxScopeError as e:
        return ApiFailResponse(message=str(e), status_code=e.status_code)
    except Exception as e:
        logger.error("[flow_message_action] inbox-bulk-update error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Bulk update failed: {str(e)}")


# ---------------------------------------------------------------------------
# Hub-mirrored conversations (Entity.remote=True). Sender, receiver, reply,
# and invitation-accept paths. These do NOT use the .flowmsg bundle flow —
# the hub holds a Conversation entity and its FlowMessages, both sides keep
# a local mirror with the hub-allocated ids.
# ---------------------------------------------------------------------------


def _invitation_common_fields(hub_inv: dict) -> dict:
    """Fields every local Invitation mirror copies verbatim from a hub
    ``pending`` entry — common to the membership and conversation paths.

    ``expiration_at`` is parsed to a real datetime (assignment on a loaded
    entity is not validated, so a raw ISO string would poison ``is_expired``).
    ``inviter`` is the hub's InvitedBy enrichment ({user_id, name} or None).
    """
    from flow_sdk.utils.serialization import iso_to_datetime  # noqa: PLC0415

    expiration_at = hub_inv.get("expiration_at")
    if expiration_at:
        try:
            expiration_at = iso_to_datetime(expiration_at)
        except ValueError:
            expiration_at = None
    inviter = hub_inv.get("inviter") or {}
    return {
        "recipient_email": normalize_email(hub_inv.get("recipient_email")) or "",
        "accepted": bool(hub_inv.get("accepted") or False),
        "sent": bool(hub_inv.get("sent") or False),
        "message": hub_inv.get("message"),
        "expiration_at": expiration_at or None,
        "sender_user_id": inviter.get("user_id"),
        "sender_name": inviter.get("name"),
    }


def _membership_cls(target_type: str | None):
    """Entity class for a membership target type (organization / team / project / …).

    A project shared as a collaboration unit rides the SAME membership-invitation
    path as org/team (target descriptor, no backing conversation): the recipient
    materializes a ``remote=True`` mirror keyed by the shared project's (uuid4) id.
    Resolves via the schema registry — the codebase's single type→class lookup (as
    used by ``share_action``); unknown/None falls back to Team for back-compat.
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    return (SchemaRegistry.get_entity_cls(target_type) if target_type else None) or Team


async def _materialize_membership_invitation(
    hub_inv: dict,
    target: dict,
    someone_typeid: str,
    *,
    notify: bool = True,
) -> Optional["Invitation"]:
    """Upsert a hub entity-share Invitation locally (``remote=True``).

    The target may be ANY shareable entity type (organization, team,
    workspace, project, skill, …). Unlike conversation invitations, these
    have no backing conversation: the inbox renders a generic row straight
    off the Invitation's ``target_*`` fields. We also mirror the target
    entity locally so the row can show its name/icon and so accept resolves
    a real entity.
    """
    from flow_sdk.app.actions.membership_sync import (  # noqa: PLC0415
        MEMBERSHIP_MIRROR_TYPES,
        materialize_remote_membership_entity,
    )
    from flow_sdk.builtin.invitation import Invitation as LocalInvitation  # noqa: PLC0415

    inv_id = hub_inv["id"]
    target_type = target.get("type")
    target_id = target.get("id")
    target_name = target.get("name")
    target_role = target.get("role")

    # Mirror the target org/team/project so name/icon resolve locally
    # (best-effort — the invitation row still renders from target_* even if
    # this fails). ALLOWLIST, not denylist: the mirror payload is just
    # {id, name, icon}, which only fits the membership containers that
    # display by ``name``. For anything else — task today; any title-only or
    # folder-backed type tomorrow — it would birth a field-less husk row
    # pre-accept (and, for asset types, mint an "untitled" folder on disk);
    # the Invitation row alone carries the display name until accept
    # materializes the real entity (e.g.
    # ``materialize_accepted_task_invitation`` for tasks).
    if target_type in MEMBERSHIP_MIRROR_TYPES:
        try:
            cls = _membership_cls(target_type)
            await materialize_remote_membership_entity(
                cls,
                {"id": target_id, "name": target_name, "icon": target.get("icon")},
                someone_typeid,
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("[inv-materialize] membership target mirror failed: %s", e)

    fields = {
        **_invitation_common_fields(hub_inv),
        "target_type": target_type,
        "target_id": target_id,
        "target_name": target_name,
        "target_role": target_role,
        "remote": True,
    }
    existing_inv = await LocalInvitation.get_one({"id": inv_id})
    if existing_inv:
        for k, v in fields.items():
            setattr(existing_inv, k, v)
        return await existing_inv.save(someone_typeid, notify=notify)
    return await LocalInvitation.model_validate({"id": inv_id, **fields}).save(
        someone_typeid,
        notify=notify,
    )


async def _materialize_invitation(
    hub_inv: dict,
    someone_typeid: str,
    *,
    notify: bool = True,
) -> tuple[Optional["Invitation"], Optional[str]]:
    """Upsert a hub-side Invitation locally — and the Conversation + preview
    FlowMessage that the hub now ships embedded in the ``pending`` response.

    Returns ``(local_invitation, conversation_id)``. ``conversation_id`` is
    None when the hub didn't embed a target Conversation (defensive — older
    hub builds without the embedding change still work, the placeholder is
    just not materialized).

    Decision #2 in the plan: invitations carry the real Conversation, so
    the recipient sees a normal ``remote=True`` Conversation row with the
    first FlowMessage already present, no synthesized "placeholder" id.
    """
    from flow_sdk.app.actions.materialize_flow_message import (  # noqa: PLC0415
        materialize_flow_message,
    )
    from flow_sdk.builtin.invitation import Invitation as LocalInvitation  # noqa: PLC0415

    if not hub_inv or not hub_inv.get("id"):
        return None, None
    inv_id = hub_inv["id"]

    # Conversation-less invitations carry a ``target`` descriptor — ANY
    # shareable entity type (organization, team, workspace, project, a
    # message, a skill, …). Materialize the Invitation with its target
    # metadata so the inbox renders a generic "<inviter> invited you to
    # <Name>" row. Gated on the ABSENCE of an embedded conversation: a
    # conversation-backed invitation always rides the thread path below, and
    # its riding asset grants must not hijack it (the hub already keeps
    # ``target`` and ``conversation`` mutually exclusive; this check makes
    # the router self-sufficient).
    target = hub_inv.get("target")
    _conv = hub_inv.get("conversation")
    has_conversation = isinstance(_conv, dict) and bool(_conv.get("id"))
    if isinstance(target, dict) and target.get("type") and target.get("id") and not has_conversation:
        return (
            await _materialize_membership_invitation(
                hub_inv,
                target,
                someone_typeid,
                notify=notify,
            ),
            None,
        )

    existing_inv = await LocalInvitation.get_one({"id": inv_id})
    # Persist the invitation→conversation linkage. The hub stamps
    # ``target_url_path`` null but embeds the target ``conversation``; without
    # writing the linkage here the local Invitation row is unmatchable to its
    # conversation (receivers polling "the invitation for conv X" can only
    # guess by recency, which breaks the moment stale invitations exist).
    from flow_sdk.builtin.invitation import conversation_target_path  # noqa: PLC0415

    _embedded = hub_inv.get("conversation")
    _target_path = hub_inv.get("target_url_path") or (
        conversation_target_path(_embedded["id"]) if isinstance(_embedded, dict) and _embedded.get("id") else None
    )
    common_fields = _invitation_common_fields(hub_inv)
    inv_fields = {
        "id": inv_id,
        **common_fields,
        "target_url_path": _target_path,
        "remote": True,
    }
    if existing_inv:
        for k, v in common_fields.items():
            setattr(existing_inv, k, v)
        if _target_path:
            existing_inv.target_url_path = _target_path
        existing_inv.remote = True
        local_inv = await existing_inv.save(someone_typeid, notify=notify)
    else:
        local_inv = await LocalInvitation.model_validate(inv_fields).save(
            someone_typeid,
            notify=notify,
        )

    if local_inv.accepted:
        return local_inv, None

    # Materialize the embedded Conversation if the hub provided one.
    embedded_conv = hub_inv.get("conversation")
    if not isinstance(embedded_conv, dict) or not embedded_conv.get("id"):
        return local_inv, None
    conv_id = embedded_conv["id"]
    try:
        # notify=False — the conversation must NOT reach the UI until its
        # kind='invitation' first message exists. The explicit CREATE ops at
        # the end of this function announce a fully-formed row instead.
        await _upsert_hub_conversation_metadata(embedded_conv, someone_typeid, notify=False)
    except Exception as e:  # noqa: BLE001
        logger.warning("[inv-materialize] conv upsert failed: %s", e)
        return local_inv, None

    # Ensure the on-disk jsonl exists so future bundle writes have a home.
    try:
        rec = from_jsonl(
            default_jsonl_path(conv_id),
            parent_id="",
            record_id=conv_id,
            parent_type=RecordType.PROJECT,
        )
        rec.save()
    except Exception as e:  # noqa: BLE001
        logger.warning("[inv-materialize] jsonl init failed: %s", e)

    # Materialize the embedded preview FlowMessage. The UI keys off
    # ``kind='invitation'`` to render the invitation row, and reads the
    # Invitation TypeId out of ``shared_context_entities`` for the Accept
    # button. notify=False here too — the explicit CREATE ops below
    # announce the FlowMessage and Conversation together, in load-bearing
    # order, only once the conversation already carries its
    # invitation-kind first message. Without this the strip/inbox briefly
    # render a navigable row.
    preview = hub_inv.get("preview_message")
    invitation_typeid = f"{LocalInvitation.get_type()}-{inv_id}"
    inv_fm = None
    if isinstance(preview, dict):
        msg_payload = dict(preview)
        msg_payload.setdefault("text", local_inv.message or "You've been invited to a conversation")
        msg_payload["kind"] = FlowMessageKind.INVITATION.value
        # Accept either the new or legacy field name on the incoming hub
        # preview, then normalize on the new name for the local write.
        existing_ctx = (
            msg_payload.pop("shared_context_entities", None) or msg_payload.pop("context_entities", None) or []
        )
        if invitation_typeid not in existing_ctx:
            existing_ctx = list(existing_ctx) + [invitation_typeid]
        msg_payload["shared_context_entities"] = existing_ctx
        msg_payload["remote"] = True
        try:
            inv_fm = await materialize_flow_message(
                msg_payload,
                conversation_id=conv_id,
                someone_typeid=someone_typeid,
                notify=False,
                # Pointer ts must be the message's hub clock, not "now" —
                # the UI sorts bubbles by pointer ts, and this materialize
                # can run after later messages already landed.
                bundle_ts=str(msg_payload.get("created_date") or "").strip() or None,
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("[inv-materialize] preview msg failed: %s", e)
    else:
        # No real ``preview_message`` embedded by the hub (sender hasn't sent
        # an actual message yet, or this is a re-poll of the same invite).
        # Synthesize an invitation-kind FM so the UI's invitation-row branch
        # matches. The text is ``local_inv.message`` (the inviter's note)
        # when present, falling back to a generic placeholder otherwise.
        #
        # The id is derived deterministically from the invitation id so that
        # when ``_materialize_invitation`` re-runs (the WS nudge and the
        # ``pending`` poll both fire it for the same invite),
        # ``materialize_flow_message`` upserts the same row instead of
        # minting a fresh duplicate each time.
        import uuid as _uuid  # noqa: PLC0415

        synth_fm_id = str(_uuid.uuid5(_uuid.NAMESPACE_OID, f"invitation-preview-{inv_id}"))
        message_text = (local_inv.message or "").strip()
        # The invite logically precedes every message in the conversation, but
        # this synth path runs on a slower async leg and loses the race against
        # live message materialization — a "now" clock would sort the notice
        # AFTER the first real message (the UI orders bubbles by pointer ts).
        # Backdate to the invitation's own hub clock (conv clock as fallback).
        # The EARLIER of the two clocks, not the first non-empty one. The notice
        # is the recipient's entry point and must sort first, but an invite into
        # an EXISTING conversation is created long after that thread's first
        # message — ordering by the invitation's own clock would file the Accept
        # gate below messages the recipient cannot read yet. Taking the minimum
        # is monotone and idempotent, and now that ordering comes from
        # ``created_date`` (not a separately-clamped pointer ts) it is the only
        # thing deciding where the notice lands.
        # Compared as datetimes, not strings — the two clocks can differ in
        # offset spelling ("Z" vs "+00:00") and precision, where a lexical min
        # silently picks the wrong one.
        _invite_candidates = [
            (Conversation._as_datetime(s), s)
            for s in (
                str(hub_inv.get("created_date") or "").strip(),
                str(embedded_conv.get("created_date") or "").strip(),
            )
            if s
        ]
        _parsed = [(dt, s) for dt, s in _invite_candidates if dt is not None]
        if _parsed:
            invite_ts = min(_parsed, key=lambda pair: pair[0])[1]
        else:
            invite_ts = _invite_candidates[0][1] if _invite_candidates else None
        synth_payload = {
            "id": synth_fm_id,
            "text": (message_text or "You've been invited to a conversation"),
            "kind": FlowMessageKind.INVITATION.value,
            "shared_context_entities": [invitation_typeid],
            "remote": False,
            # No fabricated identity: the hub sent no inviter for this notice, so
            # created_by / sender_id / sender_name stay NULL — the UI honestly
            # shows "unknown" rather than a pretend-valid sender. The
            # remote-reflection block below stops the driver stamping the local
            # recipient (who did NOT author the invite). The real inviter must
            # come from the hub (a preview_message), not be guessed here.
        }
        if invite_ts:
            synth_payload["created_date"] = invite_ts
        try:
            with remote_reflection():
                inv_fm = await materialize_flow_message(
                    synth_payload,
                    conversation_id=conv_id,
                    someone_typeid=someone_typeid,
                    notify=False,
                    bundle_ts=invite_ts,
                )
        except Exception as e:  # noqa: BLE001
            logger.warning("[inv-materialize] synth preview failed: %s", e)

    # Announce to the UI in load-bearing order — FlowMessage CREATE first so
    # the bubble row exists, then the Conversation CREATE. The conversation
    # now already carries its kind='invitation' pointer, so the strip/inbox
    # render it as a gated invitation row on the very first paint (no
    # navigable window before the Accept gate appears).
    if notify:
        try:
            from flow_sdk.api.api_types.messages import DataOpMessage, OperationType  # noqa: PLC0415
            from flow_sdk.core.network.resource_tracker import handle_entity_op  # noqa: PLC0415

            if inv_fm is not None:
                await handle_entity_op(
                    DataOpMessage(
                        data=inv_fm,
                        op=OperationType.CREATE,
                        to_entity=inv_fm.typeid,
                    )
                )
            conv_fresh = await Conversation.get_one({"id": conv_id})
            if conv_fresh is not None:
                await handle_entity_op(
                    DataOpMessage(
                        data=conv_fresh,
                        op=OperationType.CREATE,
                        to_entity=conv_fresh.typeid,
                    )
                )
        except Exception as e:  # noqa: BLE001
            logger.warning("[inv-materialize] invitation announce failed: %s", e)

    return local_inv, conv_id


# ---------------------------------------------------------------------------
# Unified conversation-list pipeline
#
# Single endpoint replacing the prior `conversation-sync` + `inbox-fetch` split.
# Reads local SQLite first (instant), pulls hub conversations + invitations in
# parallel, upserts hub metadata locally, and fans out per-conversation
# background message fetches keyed off the `message_count` delta. The hub WS
# bridge stays in place as the realtime channel; this path is the defensive
# catch-up that runs on Refresh / cold-start.
# ---------------------------------------------------------------------------

# Process-local single-flight registry for per-conversation message fetches.
# Keyed by conversation id. Prevents rapid Refresh clicks from piling up
# duplicate bundle downloads for the same conversation.
_conv_fetch_locks: dict[str, asyncio.Lock] = {}
# Conversations already claimed by a detached batch. Unlike ``Lock.locked()``,
# membership can be checked and claimed without an intervening await, so two
# drains dispatched in the same event-loop turn cannot both queue the same id
# behind the semaphore and then run it serially.
_conv_fetch_inflight: set[str] = set()


# Max parallel hub message-fetches per catch-up batch. Firing every drifted
# conversation at once saturates the single event loop + the shared connection
# pool and is end-to-end SLOWER (measured ~3.5x: 227 convs took 7.8s unbounded
# vs 2.2s at 8) — classic concurrency thrash. A small pool flows smoothly.
_BG_FETCH_CONCURRENCY = 8


async def _drain_conversation_message_fetches(pending: dict[str, Optional[datetime]], someone_typeid: str) -> None:
    """Catch up message state for many conversations, bounded concurrency.

    Runs as ONE detached task OFF the request path, so the list handler returns
    before any fetch starts (no event-loop contention with the foreground
    reconcile). The process-local claim set preserves per-conversation
    single-flight across overlapping batches.

    ``pending`` maps conversation id → the hub parent ``updated_date`` that
    justified the fetch. On success that value becomes the conversation's new
    ``hub_updated_date`` watermark — stamping it HERE, and only here, is what
    makes the watermark mean "reconciled through this hub revision". Recording
    it up-front (when the list merely SAW the row) would let a swallowed fetch
    failure certify a convergence that never happened, and a count-neutral
    change — a message edit, a delivery/body-status flip — would then stay
    invisible until the hub moved again.
    """
    sem = asyncio.Semaphore(_BG_FETCH_CONCURRENCY)

    async def _one(cid: str) -> None:
        if cid in _conv_fetch_inflight:
            return
        _conv_fetch_inflight.add(cid)
        try:
            async with sem:
                if await _fetch_conversation_messages(cid, someone_typeid):
                    await _record_hub_watermark(cid, pending.get(cid), someone_typeid)
        except Exception as e:  # noqa: BLE001
            logger.warning("[conv-msg-drain] %s failed: %s", cid[:8], e)
        finally:
            _conv_fetch_inflight.discard(cid)

    await asyncio.gather(*[_one(c) for c in pending], return_exceptions=True)


async def _record_hub_watermark(conv_id: str, hub_updated: Optional[datetime], someone_typeid: str) -> None:
    """Advance one conversation's reconciled-through watermark. Best-effort."""
    if hub_updated is None:
        return
    try:
        conv = await Conversation.get_one({"id": conv_id})
        if conv is None or Conversation._as_datetime(conv.hub_updated_date) == hub_updated:
            return
        conv.hub_updated_date = hub_updated
        with remote_reflection():
            await conv.save(someone_typeid, notify=False)
    except Exception as e:  # noqa: BLE001
        logger.warning("[conv-msg-drain] %s watermark not recorded: %s", conv_id[:8], e)


def _dispatch_conversation_message_fetches(pending: dict[str, Optional[datetime]], someone_typeid: str) -> None:
    """Fire-and-forget a whole catch-up batch as one detached, bounded drain.

    Deferred + bounded: the caller collects the drifted conversations during its
    foreground work and dispatches them all here at the very end, so the fetches
    neither interleave with the reconcile loop nor flood the loop all at once.
    """
    if not pending:
        return
    try:
        asyncio.create_task(
            _drain_conversation_message_fetches(pending, someone_typeid),
            name=f"conv-msg-drain-{len(pending)}",
        )
    except RuntimeError:
        # No running loop (e.g. a sync call context) — nothing to schedule.
        pass


async def _materialize_remote_child(cls, data: dict, parent_ref: str, someone_typeid: str | None):
    """Upsert a hub child dict locally as a remote is_child of ``parent_ref``.

    Thin wrapper over ``Entity.upsert_from_hub_child`` (shared with the live
    bridge path). Returns the saved entity."""
    return await cls.upsert_from_hub_child(data, parent_ref, someone_typeid)


async def _sync_remote_children(parent_tid: TypeId, child_type: str, someone_typeid: str | None) -> set[str]:
    """Pull ``parent_tid``'s hub children of ``child_type`` and materialize the
    new/changed ones locally (LWW via ``is_stale``). Best-effort. Returns the set
    of hub child ids seen, so the caller can reconcile local deletions (children
    removed on the hub whose row still lingers locally)."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    cls = SchemaRegistry.get_entity_cls(child_type)
    if cls is None:
        return set()
    # hub_get expects a BuiltinEntityType for the entity_type arg (it reads
    # ``.value``); parent_tid.type is a plain string, so coerce.
    try:
        parent_etype = BuiltinEntityType(parent_tid.type)
    except ValueError:
        parent_etype = parent_tid.type
    # expand=blobs: blob fields (e.g. comment raw_content) are db-excluded from the
    # hub row and served only on request — without this the pull materializes
    # children with EMPTY bodies (the live-push path carries them; catch-up must too).
    children = await hub_get(parent_etype, parent_tid.id, action=child_type, params={"expand": "blobs"})
    child_list = rows_of(children)
    parent_ref = f"{parent_tid.type}-{parent_tid.id}"
    hub_ids: set[str] = set()
    for raw in child_list:
        if not isinstance(raw, dict) or not raw.get("id"):
            continue
        hub_ids.add(raw["id"])
        local = await cls.get_one({"id": raw["id"]})
        if local is not None and not cls.is_stale(local, raw):
            continue
        try:
            await _materialize_remote_child(cls, raw, parent_ref, someone_typeid)
        except Exception as e:  # noqa: BLE001
            logger.warning("[subtree-sync] materialize %s-%s failed (non-fatal): %s", child_type, raw.get("id"), e)
    return hub_ids


async def _reconcile_deleted_children(conv, child_type: str, hub_ids: set[str], someone_typeid: str | None) -> None:
    """Catch-up's delete half: prune local ``remote`` children of this
    conversation whose hub row is gone (id not in ``hub_ids``).

    The pull half (``_sync_remote_children``) only adds/updates; without this a
    comment deleted by a peer lingers forever for anyone who wasn't live-watching.
    The local ``delete_by_id`` fans the normal delete data-op, so the FE drops it.

    Candidate parents are the conversation itself AND each ``shared_context``
    doc — a child rides the hub under the conversation but binds locally to its
    real parent, which is either the conversation (a direct comment) or a shared
    doc (``parent_type_id`` = the markdown). Only ``remote`` rows are pruned
    (never a locally-authored, not-yet-shared child)."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    cls = SchemaRegistry.get_entity_cls(child_type)
    if cls is None:
        return
    try:
        child_etype = BuiltinEntityType(child_type)
    except ValueError:
        child_etype = None
    conv_ref = f"{BuiltinEntityType.CONVERSATION.value}-{conv.id}"
    candidate_parents = [conv_ref, *(str(r) for r in (conv.shared_context_entities or []))]
    for parent_ref in candidate_parents:
        try:
            local_children = await cls.get_all({"parent_type_id": parent_ref})
        except Exception:  # noqa: BLE001
            continue
        for ent in local_children or []:
            if not getattr(ent, "remote", False) or ent.id in hub_ids:
                continue
            # ``hub_ids`` is the conversation's child LIST, which can momentarily
            # lag a just-shared comment (eventual consistency). Confirm the row is
            # REALLY gone with a direct hub GET before pruning — otherwise a fresh
            # comment, already delivered to a live-watching peer, would be deleted
            # out from under it on the next catch-up sync (the create/update race).
            if child_etype is not None:
                try:
                    if await hub_get(child_etype, ent.id) is not None:
                        continue  # still on the hub → a list lag, not a deletion
                except Exception:  # noqa: BLE001
                    continue  # couldn't confirm → never prune on uncertainty
            try:
                await cls.delete_by_id(ent.id)
                logger.info("[subtree-sync] reconciled delete %s-%s (confirmed removed on hub)", child_type, ent.id)
            except Exception as e:  # noqa: BLE001
                logger.warning("[subtree-sync] reconcile delete %s-%s failed (non-fatal): %s", child_type, ent.id, e)


async def _sync_shared_context_subtree(conv_id: str, someone_typeid: str | None) -> None:
    """Recursive-share catch-up for one conversation.

    For each ``shared_context_entities`` member (e.g. the shared markdown):
      1. Link the locally-materialized ones to this conversation (parent_type_id)
         so effective-remote resolves and comments auto-share.
      2. Pull its child comments from the hub as remote children.

    NO stub minting here: shared-context rows are materialized exclusively by
    the bundle download → unpack pipeline (``_process_single_hub_message`` /
    ``_download_and_unpack_bundle``), which carries the real entity data. A
    placeholder row minted ahead of the bundle used to permanently block the
    unpack's exists-check from landing the real fields. Refs whose bundle
    hasn't arrived yet are simply skipped by the linker and picked up on the
    next sync pass — order no longer decides the outcome.

    This is what lets a recipient who never watched the doc/conversation live
    still see everyone's comments after a sync. Best-effort; never raises."""
    try:
        conv = await Conversation.get_one({"id": conv_id})
        if conv is None:
            return
        # 1) Link each locally-present shared-context doc to this conversation so
        #    its ``effective_remote`` resolves (the doc is NOT a hub entity — its
        #    content arrives via the bundle unpack). Only when docs are shared;
        #    missing rows are skipped (bundle not downloaded yet).
        if conv.shared_context_entities:
            await conv._link_context_to_conversation()
        # 2) ALWAYS pull the conversation's hub child entities (comments) +
        #    reconcile — a conversation-direct comment needs no shared doc, and a
        #    comment on a shared doc rides the hub under the conversation either
        #    way (it carries its real doc parent in ``parent_type_id``). Driven by
        #    the registry (``shared_child=True``), like the live bridge.
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        conv_tid = TypeId(f"{BuiltinEntityType.CONVERSATION.value}-{conv_id}")
        for child_type in SchemaRegistry.get_shared_child_types():
            hub_ids = await _sync_remote_children(conv_tid, child_type, someone_typeid)
            # Delete half: prune local children removed on the hub (the pull above
            # only adds/updates), so a non-watching peer converges on deletions.
            await _reconcile_deleted_children(conv, child_type, hub_ids, someone_typeid)
            # 3) Rebind half: recreate missing parent edges for remote children
            #    whose parent materialized AFTER they did (e.g. the doc installed
            #    after its comments synced) or that were synced before edge
            #    recreation existed. The is_stale LWW skip means such rows never
            #    re-materialize — this pass is their only healer. Skipped when the
            #    hub has no children of this type (nothing can be orphaned), so
            #    child-free conversations pay nothing per sync.
            if hub_ids:
                await _rebind_orphan_children(conv, child_type, someone_typeid)
    except Exception as e:  # noqa: BLE001
        logger.warning("[subtree-sync] conv=%s failed (non-fatal): %s", conv_id, e)


async def _rebind_orphan_children(conv, child_type: str, someone_typeid: str | None) -> None:
    """Recreate missing local parent edges for this conversation's remote children.

    Candidate parents mirror ``_reconcile_deleted_children``: the conversation
    itself plus each ``shared_context_entities`` doc. Each ``remote=True``
    ``child_type`` row bound to a candidate parent gets ``ensure_child_edge()``
    — which resolves the parent locally, dedup-checks the ``is_child`` role
    edge, and attaches only when missing. Best-effort per row. Callers gate on
    "the hub reported children of this type" so child-free syncs skip entirely.
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    cls = SchemaRegistry.get_entity_cls(child_type)
    if cls is None:
        return
    conv_ref = f"{BuiltinEntityType.CONVERSATION.value}-{conv.id}"
    candidate_parents = [conv_ref, *(str(r) for r in (conv.shared_context_entities or []))]
    for parent_ref in candidate_parents:
        try:
            children = await cls.get_all({"parent_type_id": parent_ref})
        except Exception:  # noqa: BLE001
            continue
        for ent in children or []:
            if not getattr(ent, "remote", False):
                continue  # locally-authored rows got their edge at create
            try:
                await ent.ensure_child_edge()
            except Exception as e:  # noqa: BLE001
                logger.warning(
                    "[subtree-sync] rebind %s-%s failed (non-fatal): %s",
                    child_type,
                    ent.id,
                    e,
                )


def _parse_pointer_ts(value: str | None) -> Optional[datetime]:
    """Parse a Pointer's ISO ts for comparison; None when unparseable.
    Naive stamps are read as UTC so aware/naive mixes stay comparable."""
    try:
        dt = datetime.fromisoformat((value or "").strip().replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt


def _clamp_invitation_ts(invitations: list[Pointer], merged: list[Pointer]) -> list[Pointer]:
    """Clamp each invitation pointer's ts to the earliest hub-message ts.

    Prepending the invitation isn't enough on its own: the UI re-sorts rows
    by pointer ts (conversation-items.ts), so an invitation whose ts
    post-dates the first real message would swap back after first paint.
    On the resulting tie, the stable sort keeps the prepended invitation
    first. Idempotent, so it also self-heals pointers written before this
    fix. Pointers with an unparseable ts are clamped too (fail-first).
    """
    if not invitations or not merged:
        return invitations
    hub_keys = [(key, p.ts) for p in merged if (key := _parse_pointer_ts(p.ts)) is not None]
    if not hub_keys:
        return invitations
    earliest_key, earliest_ts = min(hub_keys, key=lambda kv: kv[0])
    return [
        p if (k := _parse_pointer_ts(p.ts)) is not None and k <= earliest_key else Pointer(p.typeid, earliest_ts)
        for p in invitations
    ]


async def _fetch_conversation_messages(conv_id: str, someone_typeid: str) -> bool:
    """Bring local message state for a single conversation up to the hub's.

    Lists the conversation's child FlowMessages via the children-list route
    ``/conversation/<id>/flow_message`` in ONE request — each child carries its
    ``updated_date``, so we diff **new ∪ changed** (not new-only): every child
    is routed through ``_process_single_hub_message``, which applies the LWW
    invalidation rule (``Entity.is_stale``) and is a no-op for rows already
    current. A conversation whose messages are all unchanged does zero writes
    and zero per-message GETs.

    Replaces the prior approach (read the ``message_ids`` pointer projection,
    diff new-only, then one ``hub_get(FLOW_MESSAGE, id)`` per missing id) — that
    missed edits and fanned out N requests. The children route returns the full
    FM dicts, so the per-id GET loop is gone.

    All exceptions are logged and swallowed — this runs as a detached task and
    must never crash the event loop. Returns True only when the reconcile
    actually completed, so the caller can decide whether it may advance the
    conversation's ``hub_updated_date`` watermark (see
    ``_drain_conversation_message_fetches``). A swallowed failure must NOT be
    allowed to certify convergence.
    """
    lock = _conv_fetch_locks.setdefault(conv_id, asyncio.Lock())
    async with lock:
        try:
            # Children-list route, primary source: returns the conversation's
            # FlowMessage children (with updated_date) the caller may see.
            # hub_get's url builder requires an action segment before sub_path.
            children = await hub_get(
                BuiltinEntityType.CONVERSATION,
                conv_id,
                action="flow_message",
            )
            # hub_get returns the unwrapped `data` when 200 and None on any
            # failure. None ⇒ we cannot prove anything — abort without
            # touching local state. An EMPTY LIST is a real answer ("this
            # conversation has zero messages you may see") and still goes
            # through the authoritative reconcile below.
            if children is None:
                logger.warning("[conv-msg-fetch] %s: children listing unavailable, skipping", conv_id[:8])
                return False
            child_list = [m for m in rows_of(children) if m.get("id")]
            child_list = fetch_order(child_list)
            synced = 0
            for raw_fm in child_list:
                fm_id = raw_fm["id"]
                # Cheap skip: already-current rows need no metadata work, but
                # READY-body recovery is independent. Push is best-effort; an
                # exact pull must still download a missing body or heal a local
                # pack-time UPLOADING marker after the Hub reached READY.
                local = await FlowMessage.get_one({"id": fm_id})
                hub_body_status = _body_status_value(raw_fm.get("body_status"))
                local_body_status = _body_status_value(getattr(local, "body_status", None))
                attachment_filename = (raw_fm.get("attachment_filename") or "").strip()
                needs_body_reconcile = bool(
                    local is not None
                    and attachment_filename
                    and hub_body_status == BodyStatus.READY.value
                    and (local_body_status != BodyStatus.READY.value or not local.is_body_downloaded())
                )
                # ``hub_created_drift`` is OR-ed in for the same reason the
                # conversation list OR-s ``_created_drift`` into its upsert gate: a
                # birth-time repair CANNOT ride ``is_stale``. A row re-materialized
                # from a send-time-less bundle carries ``now()``, which outranks the
                # hub clock, so this gate would ``continue`` past the very rows that
                # need repairing and the fix inside _process_single_hub_message would
                # never be reached.
                if (
                    not FlowMessage.is_stale(local, raw_fm)
                    and not needs_body_reconcile
                    and not hub_created_drift(local, raw_fm)
                ):
                    continue
                try:
                    # Hub's FM payload doesn't carry conversation_id (the graph
                    # edge is the source of truth on the hub). The local-side
                    # _process_single_hub_message + pointer-append flow needs it
                    # to know which conversation.jsonl to update. Inject it.
                    raw_fm.setdefault("conversation_id", conv_id)
                    await _process_single_hub_message(raw_fm)
                    synced += 1
                except Exception as e:  # noqa: BLE001
                    logger.warning(
                        "[conv-msg-fetch] %s: fm=%s failed: %s",
                        conv_id[:8],
                        fm_id,
                        e,
                    )
            # Authoritative reconcile — the hub child list IS the message set.
            # Rewrite conversation.jsonl to exactly (hub children, in
            # created_date order) ∪ (local-pending not yet on the hub), then
            # re-project unconditionally (no-op when already in sync). One
            # mechanism covers: offline deletes (local pointer absent on hub →
            # dropped), bare rows after a DB rebuild (projection rebuilt from
            # the merged set), and orphan entities (pointer lost from the file
            # → restored from the hub list).
            try:
                rec = from_jsonl(
                    default_jsonl_path(conv_id),
                    parent_id="",
                    record_id=conv_id,
                    parent_type=RecordType.PROJECT,
                )
                hub_ids = {m["id"] for m in child_list}
                merged: list[Pointer] = [
                    Pointer(
                        TypeId(type=Pointer.DEFAULT_MESSAGE_TYPE, id=m["id"]),
                        str(m.get("created_date") or "") or datetime.now(UTC).isoformat(),
                    )
                    for m in child_list
                ]
                dropped = 0
                # Invitation placeholders are the conversation's logical first
                # message, but their own ts post-dates the first real message
                # (the synth path loses a materialization race), so neither
                # appending nor ts-sorting puts them right — prepend them.
                invitations: list[Pointer] = []
                for ptr in message_pointers(rec):
                    if ptr.id in hub_ids:
                        continue  # hub-confirmed; already in merged
                    # Local-pending: provably local-born rows the hub can't
                    # know about yet — pre-accept (CREATED), invitation
                    # placeholders, drafts, or any row without a confirmed
                    # hub twin (remote=False). Fail-closed: a pointer whose
                    # FM row can't be loaded is KEPT, never dropped on
                    # uncertainty.
                    try:
                        fm = await FlowMessage.get_one({"id": ptr.id})
                    except Exception:  # noqa: BLE001
                        fm = None
                    keep = (
                        fm is None
                        or fm.delivery_status == DeliveryStatus.CREATED.value
                        or fm.kind == FlowMessageKind.INVITATION
                        or bool(getattr(fm, "is_draft", False))
                        or not fm.remote
                    )
                    if not keep:
                        # remote=True and absent from the hub list ⇒ deleted
                        # hub-side (or access revoked) — drop the stale copy.
                        dropped += 1
                    elif fm is not None and fm.kind == FlowMessageKind.INVITATION:
                        invitations.append(ptr)
                    else:
                        merged.append(ptr)
                write_pointers(rec, _clamp_invitation_ts(invitations, merged) + merged)
                await project_pointers_to_entity(rec, notify=True)
                if dropped:
                    logger.info(
                        "[conv-msg-fetch] %s: reconcile dropped %d hub-deleted pointer(s)",
                        conv_id[:8],
                        dropped,
                    )
            except Exception as e:  # noqa: BLE001
                logger.warning(
                    "[conv-msg-fetch] %s: authoritative reconcile failed: %s",
                    conv_id[:8],
                    e,
                )
            logger.info(
                "[conv-msg-fetch] %s: synced %d of %d hub message(s)",
                conv_id[:8],
                synced,
                len(child_list),
            )
            return True
        except Exception as e:  # noqa: BLE001
            logger.warning("[conv-msg-fetch] %s: aborted: %s", conv_id[:8], e)
            return False


async def _ensure_local_conversation_synced(conv_id: str, someone_typeid: str) -> None:
    """Make sure the local DB has the conv + its messages.

    Idempotent. Used by deep-link handlers (``handle_open_flow_message``) for
    flows where the FM ships without a body bundle (e.g. text-only first
    message from a fresh share) and the recipient would otherwise see a
    placeholder or an empty conv.
    """
    from flow_sdk.builtin.conversation import Conversation as LocalConversation  # noqa: PLC0415

    # Join the hub-side conv so we enter ``participants`` and start
    # receiving WS fanout. Idempotent — already-a-member is a no-op.
    try:
        await hub_post(BuiltinEntityType.CONVERSATION, {}, conv_id, "join")
    except Exception as e:
        logger.debug("[conv-sync] join %s: %s", conv_id[:8], e)

    # Materialize the local row from the hub if it's missing.
    existing = await LocalConversation.get_one({"id": conv_id})
    if existing is None:
        try:
            hub_conv = await hub_get(BuiltinEntityType.CONVERSATION, conv_id)
            if isinstance(hub_conv, dict) and hub_conv.get("id"):
                await LocalConversation.model_validate(
                    {
                        "id": conv_id,
                        "title": hub_conv.get("title"),
                        "remote": True,
                    }
                ).save(someone_typeid)
        except Exception as e:
            logger.debug("[conv-sync] materialize %s: %s", conv_id[:8], e)

    # Pull any messages the WS bridge didn't fan out (everything from before
    # the join in particular).
    await _sync_conversation_messages(conv_id, someone_typeid)


async def _sync_conversation_messages(
    conv_id: str,
    someone_typeid: str,
    *,
    download_bundles: bool = True,
) -> None:
    """Materialize every hub-side message of a conversation into the local store.

    Uses the standard scoped query ``GET /graph/conversation/<id>/flow_message``
    — the hub returns the conversation's child FlowMessages the caller is
    authorized to see (the dual role-path auth is satisfied once the caller
    has joined the conversation). Each FM is materialized via
    ``materialize_flow_message``, which is idempotent, so messages already
    delivered through the WS bridge are no-ops.

    Called after an invitation accept: the hub WS only fanouts messages from
    join-time forward, so the inviter's pre-accept messages (notably the
    first one) need this explicit pull. Callers that request bundle downloads
    also unpack attachment-bearing messages; invitation acceptance disables
    that part because the message UI owns the explicit Download/staging step.
    """
    from flow_sdk.app.actions.materialize_flow_message import (  # noqa: PLC0415
        materialize_flow_message,
    )

    hub_msgs = await hub_get(
        BuiltinEntityType.FLOW_MESSAGE,
        scope=[("conversation", conv_id)],
    )
    ordered = sorted(
        (m for m in (hub_msgs or []) if isinstance(m, dict) and m.get("id")),
        key=lambda m: m.get("created_date") or "",
    )
    logger.info("[conv-sync] conv=%s: syncing %d message(s)", conv_id[:8], len(ordered))
    for raw_fm in ordered:
        try:
            await materialize_flow_message(
                raw_fm,
                conversation_id=conv_id,
                someone_typeid=someone_typeid,
                notify=True,
                remote=True,
            )
        except Exception as fm_err:  # noqa: BLE001
            logger.warning(
                "[conv-sync] conv=%s fm=%s materialize failed: %s",
                conv_id[:8],
                raw_fm.get("id"),
                fm_err,
            )
            continue
        if not download_bundles:
            continue
        await _pull_bundle_for_hub_fm(conv_id, raw_fm)


async def _pull_bundle_for_hub_fm(conv_id: str, raw_fm: dict) -> None:
    """Download + unpack one hub FlowMessage's bundle body. Never raises.

    The single implementation of "pull this message's body", shared by the
    inline ``_sync_conversation_messages`` loop and the deferred
    ``_pull_conversation_bundles`` below. ``_download_and_unpack_bundle``
    self-gates on ``body_status`` (no-op unless READY) and ``unpack_bundle`` is
    idempotent, so calling it twice for the same message is harmless.
    """
    attachment_filename = (raw_fm.get("attachment_filename") or "").strip()
    if not attachment_filename:
        return
    try:
        await _download_and_unpack_bundle(
            raw_fm["id"],
            attachment_filename,
            body_status=raw_fm.get("body_status"),
            # Hub's delivery clock — see the note at the other catch-up call site.
            # Without it a legacy bundle lands with its send-time as recency and
            # the conversation dives until the following merge corrects it.
            hub_updated=raw_fm.get("updated_date"),
        )
    except Exception as b_err:  # noqa: BLE001
        logger.warning(
            "[conv-sync] conv=%s fm=%s bundle download failed: %s",
            conv_id[:8],
            raw_fm.get("id"),
            b_err,
        )


async def _pull_conversation_bundles(conv_id: str) -> None:
    """Deferred body pull for a whole conversation — the bytes half of
    ``_sync_conversation_messages``, run on its own after the metadata half.

    Invitation-accept syncs metadata with ``download_bundles=False`` to keep the
    Accept request off the filesystem. But accept is the ONLY pass that ever
    sees the inviter's pre-accept messages (the hub WS fanouts from join-time
    forward), so skipping the download there skipped it outright: a body-less
    first message, no staged MessageAttachment rows, no entity chip. This runs
    the same pull immediately after the response instead of during it.
    """
    hub_msgs = await hub_get(
        BuiltinEntityType.FLOW_MESSAGE,
        scope=[("conversation", conv_id)],
    )
    for raw_fm in hub_msgs or []:
        if isinstance(raw_fm, dict) and raw_fm.get("id"):
            await _pull_bundle_for_hub_fm(conv_id, raw_fm)


def _schedule_conversation_bundle_pull(conv_id: str) -> None:
    """Fire-and-forget ``_pull_conversation_bundles`` off the request path.

    Mirrors ``_schedule_conversation_message_fetches``: accept stays a pure
    membership+metadata call, the filesystem work runs after it returns.
    """
    try:
        asyncio.create_task(
            _pull_conversation_bundles(conv_id),
            name=f"conv-bundle-pull-{conv_id[:8]}",
        )
    except RuntimeError:
        # No running loop (e.g. a sync call context) — nothing to schedule.
        pass


_UNSET = object()  # sentinel: distinguishes "existing not provided" from "known absent (None)"


async def _upsert_hub_conversation_metadata(
    hub_conv: dict,
    someone_typeid: str,
    *,
    notify: bool = True,
    existing=_UNSET,
    learned_rosters: Optional[set[str]] = None,
) -> Optional[Conversation]:
    """Upsert a hub-side Conversation into the local SQLite table.

    ``learned_rosters`` is a per-batch memo of rosters already pushed into the
    address book: a hub account's conversations mostly share one roster, and
    without the memo a fresh mirror learned the same two contacts once per
    conversation (two DB reads each). The batch caller owns the set.

    ``existing`` lets a caller that already holds the local row (e.g. the
    conversation-list bulk-read cache) pass it in to skip the per-row
    ``get_one``. Pass ``None`` for "known absent" (→ create path); omit it
    entirely to have this function load the row itself.

    Copies the user-visible metadata (``title``, ``participants``,
    ``remote_project_id`` / ``remote_project_name``) onto the local row and
    marks ``remote=True``. **Does not touch**
    ``message_ids`` / ``message_count`` — those are projection-guarded on the
    local side and only legitimately written by
    ``ConversationRecord._project_pointers_to_entity`` as bundles are unpacked.

    ``notify=False`` saves the row without broadcasting the entity op — used
    by the invitation pipeline, which must materialize the conversation's
    ``kind='invitation'`` first message *before* the UI ever sees the
    conversation (otherwise the strip/inbox briefly render it as a normal,
    navigable row). The caller emits the CREATE op itself once the row is
    fully formed.
    """
    conv_id = (hub_conv.get("id") or "").strip()
    if not conv_id:
        return None
    # Defensive: if the hub signals this conv was deleted (audit-only on
    # hub-side after owner-delete), we still expect the prune step to clear
    # the local row. Short-circuit here so we don't re-create it.
    if hub_conv.get("deleted_at"):
        existing = await Conversation.get_one({"id": conv_id})
        if existing is not None:
            try:
                await _hard_delete_local_conversation(existing)
            except Exception as e:  # noqa: BLE001
                logger.warning("[conv-upsert] deleted_at hub row, local cleanup failed: %s", e)
        return None
    if existing is _UNSET:
        existing = await Conversation.get_one({"id": conv_id})
    # Receive-side address-book reconcile (rule 3): every conversation that syncs
    # down from the hub upserts its roster into the address book. This is the
    # passive path (conversation-list background sync, WS reflection) — the one
    # that previously wrote participants onto the row but never learned contacts.
    # Runs outside the remote_reflection() conv-save blocks below (contacts are
    # independent local rows). Gated to a roster CHANGE (new conv, or the hub
    # roster differs from what we've stored) so a steady-state re-sync of N
    # conversations doesn't fan out N×M no-op contact upserts on this hot path.
    # Best-effort: never fail a conv sync over it.
    roster = hub_conv.get("participants")
    if isinstance(roster, list) and roster:
        norm_roster = _normalize_participants(roster)
        roster_key = _json.dumps(norm_roster, sort_keys=True, default=str)
        if (existing is None or (existing.members or []) != norm_roster) and (
            learned_rosters is None or roster_key not in learned_rosters
        ):
            try:
                await _learn_normalized_participants(norm_roster)
                if learned_rosters is not None:
                    learned_rosters.add(roster_key)
            except Exception as learn_err:  # noqa: BLE001
                logger.debug("[conv-upsert] address-book learn failed for conv=%s: %s", conv_id[:8], learn_err)
    if existing is None:
        payload: dict = {"id": conv_id, "remote": True}
        # ``kind`` is hub-authoritative for a hub-owned conversation. Omitting
        # it filed every picked-up support ticket as an ordinary ``direct``
        # chat on the STAFF side — the hub said ``helpdesk``, the local row
        # said otherwise, and the desk's own queue view could not recognise its
        # own tickets. The requester side had been papering over this by
        # re-stamping HELPDESK after the fact; pickup had no such workaround.
        for k in (
            "title",
            "kind",
            "participants",
            "remote_project_id",
            "remote_project_name",
            "shared_context_entities",
        ):
            if hub_conv.get(k) is not None:
                payload[_local_roster_key(k)] = (
                    _normalize_participants(hub_conv[k])
                    if k == "participants" and isinstance(hub_conv[k], list)
                    else hub_conv[k]
                )
        # Hub owner field ``initiated_by`` mirrors locally as ``created_by``,
        # carried VERBATIM — including ``None`` (share-created conversations
        # carry no owner). The receiver must NOT fabricate a 'system' sentinel
        # nor let the driver stamp the local user; the remote-reflection block
        # around the save guarantees both. A null owner resolves for display via
        # the participant roster's ``owner`` role.
        if hub_conv.get("initiated_by") is not None:
            payload["created_by"] = hub_conv["initiated_by"]
        if hub_conv.get("git_sharing_enabled") is not None:
            payload["git_sharing_enabled"] = bool(hub_conv["git_sharing_enabled"])
        # Carry the hub's updated_date so the local row records the hub
        # timestamp — the LWW decision point that lets conversation-list detect
        # "this conversation changed" by comparing parent updated_date alone,
        # without listing messages (Entity.is_stale). The driver preserves a
        # non-None updated_date on save.
        if hub_conv.get("updated_date") is not None:
            payload["updated_date"] = hub_conv["updated_date"]
        # The hub is the source of truth for when the conversation was born —
        # without this, a locally re-created row (e.g. after a DB rebuild)
        # claims its re-creation moment as the creation date. The driver
        # preserves a preset created_date on save.
        if hub_conv.get("created_date") is not None:
            payload["created_date"] = hub_conv["created_date"]
        payload["fetched_at"] = datetime.now(UTC)
        # Deterministically adopt the local owning project from the shared/target
        # entity (same rule as local create / receive). The hub never carries a
        # local ``project_id`` — only ``remote_project_id`` (the sender's). When a
        # shared entity resolves to a local project, stamp it so the conversation
        # lands in that project without the receiver "map a project" prompt; an
        # entity-less remote chat stays project-less (None) by design.
        derived_project_id = await Conversation.resolve_project_id(payload.get("shared_context_entities"))
        if derived_project_id:
            payload["project_id"] = derived_project_id
        conv = Conversation.model_validate(payload)
        conv.id = conv_id
        # Pure reflection of the hub row: preserve created_by/updated_by/dates
        # verbatim, never the local sync user.
        with remote_reflection():
            return await conv.save(someone_typeid, notify=notify)
    # Update path: copy hub-owned fields without touching projections.
    changed = False
    for k in ("title", "kind", "participants", "remote_project_id", "remote_project_name"):
        v = hub_conv.get(k)
        if k == "participants" and isinstance(v, list):
            v = _normalize_participants(v)
        dest = _local_roster_key(k)
        if v is not None and getattr(existing, dest, None) != v:
            setattr(existing, dest, v)
            changed = True
    # ``shared_context_entities`` is wire-bound (hub-authoritative): adopt the
    # hub's list when it differs. Local is list[TypeId], hub returns list[str] —
    # compare via string projection so a re-echo of the same set is a no-op.
    hub_ctx = hub_conv.get("shared_context_entities")
    if isinstance(hub_ctx, list):
        local_ctx = [str(t) for t in (existing.shared_context_entities or [])]
        if local_ctx != [str(c) for c in hub_ctx]:
            existing.shared_context_entities = hub_ctx
            changed = True
    hub_owner = hub_conv.get("initiated_by")
    if hub_owner is not None and getattr(existing, "created_by", None) != hub_owner:
        existing.created_by = hub_owner
        changed = True
    if hub_conv.get("git_sharing_enabled") is not None and existing.git_sharing_enabled != bool(
        hub_conv["git_sharing_enabled"]
    ):
        existing.git_sharing_enabled = bool(hub_conv["git_sharing_enabled"])
        changed = True
    if not existing.remote:
        existing.remote = True
        changed = True
    # Always-adopt the hub's created_date (hub-authoritative birth time) — repairs
    # rows re-created locally with a bogus created_date (e.g. after a DB rebuild).
    if adopt_hub_created_date(existing, hub_conv):
        changed = True
    # Deliberately NOT adopting the hub parent ``updated_date`` as local recency:
    # the hub re-stamps it on bare touches (a child's body re-download), which
    # would surface a days-old conversation as "just now". Recency stays owned by
    # ``project_pointers_to_entity`` (derived from messages' real-change clocks).
    # The hub clock IS persisted, as ``Conversation.hub_updated_date`` — but by the
    # drain, once the reconcile it justified has actually succeeded, never here.
    if changed:
        # We just refreshed this row from a hub payload — stamp the boundary.
        existing.fetched_at = datetime.now(UTC)
        # Reflection: don't let apply_update_fields clobber updated_by with the
        # local sync user — the hub's updated_date/owner are authoritative here.
        with remote_reflection():
            return await existing.save(someone_typeid, notify=notify)
    return existing


def fetch_order(hub_messages: list[dict]) -> list[dict]:
    """Order a conversation's hub messages for materializing: NEWEST first.

    A conversation's inbox recency is ``max(message.updated_date)``, so the newest
    message alone decides its position. Materialize that one first and the row
    lands in its final slot on the first write; every older message that follows
    leaves the max untouched and moves nothing.

    Oldest-first — what this used to do — left the recency wrong until the very
    last arrival and nudged the conversation up the list on every single one: N
    visible moves per conversation instead of one. Measured on a real backlog
    pull, the flip took the churn from 21 moving frames down to 4.

    Processing order ONLY. The stored order stays chronological: the authoritative
    reconcile rewrites ``conversation.jsonl`` in ``created_date`` order, and
    ``project_pointers_to_entity`` reads the child edges with
    ``order_by={"created_date": "asc"}``.
    """
    return sorted(hub_messages, key=lambda m: m.get("created_date") or "", reverse=True)


def _should_fetch_messages(
    local_conv: Optional[Conversation], hub_conv: dict, *, clock_moved: bool | None = None
) -> bool:
    """Out-of-sync detection for one conversation — the dispatch gate of the
    list pipeline. Two independent signals, OR-ed (the hub is the source of
    truth; either one firing invalidates the local copy via the authoritative
    reconcile in ``_fetch_conversation_messages``):

    - hub-clock watermark (``Conversation.hub_clock_moved``): the hub bumps the
      parent on child add/edit/delete AND on delivery/body status changes, so one
      cheap parent compare catches every content/status change. NOT
      ``Entity.is_stale`` — see ``Conversation.hub_updated_date`` for why that
      comparison never converges on this type.
    - ``message_count`` mismatch, BIDIRECTIONAL: catches drift the date can't
      prove — e.g. a local row re-created bare from the hub (carries the hub's
      updated_date, so is_stale says current, but reports 0 messages), or a
      stale local extra after a missed delete.

    Hub count ``None`` (old hub / pre-field row) ⇒ unknown. Date-only then,
    EXCEPT when the local projection is empty: an empty cache we cannot
    verify cheaply is exactly the bare-row incident shape, so dispatch the
    (single-flight, cheap) fetch and let the authoritative reconcile settle
    it. A genuinely empty conversation just reconciles to empty again; once
    the hub ships counts this branch never fires.

    A hub-deleted conversation is a hard "no" before any of the above: the
    user deleted it, so ``local_conv`` is (correctly) always None going
    forward, which would otherwise read as "never synced" forever and
    re-dispatch a fetch that resurrects its full message history on every
    single list call.
    """
    if hub_conv.get("deleted_at"):
        return False
    if local_conv is None:
        return True
    if clock_moved is None:
        clock_moved = Conversation.hub_clock_moved(local_conv, Conversation._as_datetime(hub_conv.get("updated_date")))
    if clock_moved:
        return True
    raw_hub_count = hub_conv.get("message_count")
    if raw_hub_count is None:
        return not local_conv.message_ids
    local_count = int(local_conv.message_count or 0)
    return int(raw_hub_count) != local_count


async def _local_only_conversation_list(*, auth_required: bool, user_id: str | None = None) -> ApiSuccessResponse:
    """Local-only conversation-list response: render whatever's in SQLite and
    flag the hub unreachable. Used when the hub isn't configured
    (``auth_required=False``) or there's no cloud session (``auth_required=True``).

    If user_id is provided, only conversations created by that user are returned."""
    filter_dict = {"created_by": user_id} if user_id else {}
    local = await Conversation.get_all(filter_dict)
    return ApiSuccessResponse(
        data={
            "conversations": [c.model_dump(mode="json") for c in local],
            "bg_fetch_dispatched": [],
            "hub_reachable": False,
            "auth_required": auth_required,
        }
    )


async def handle_conversation_list(someone_typeid, *, announce_invitations: bool = False) -> ApiResponse:
    """Unified conversation list: local SQLite + hub catch-up + background message fetch.

    ``announce_invitations`` says whether a client refetch rides behind this
    call. The UI action path leaves it False: the caller refetches its own
    query once when the response lands, so broadcasting each materialized
    invitation individually would only churn the Inbox order mid-catch-up.
    The backend-initiated sweeps (``inbox.catchup``) have no such refetch —
    nobody asked for this call — so they pass True and the invitation rows
    reach the already-mounted UI.

    Pipeline (all stages run inside the request handler unless noted):

    1. Read local conversations from SQLite (the canonical render source).
    2. In parallel, hub_get(CONVERSATION) + hub_get(INVITATION, pending).
       Failures here are non-fatal — we degrade to local-only with a flag.
    3. For each hub conversation, upsert metadata locally (title, participants,
       updated_date, etc.). If the hub's parent ``updated_date`` is newer than
       the local copy's (bumped on add OR edit of any child message), queue a
       single-flight background message sync.
    4. For each pending invitation, run the existing
       ``_materialize_remote_invitation`` + placeholder-conversation pipeline.
    5. Return the freshly-merged local list. Background fetches run after the
       HTTP response is sent; their results stream in via WS data_op_msg.
    """
    # Extract user ID from someone_typeid (could be TypeId object or string)
    user_id = someone_typeid.id if hasattr(someone_typeid, "id") else str(someone_typeid).split("-", 1)[-1]
    logger.info(f"[conversation-list] Filtering for user_id: {user_id}")

    if not hub_base_url():
        # Local-only mode: still return whatever's in SQLite so the UI renders.
        return await _local_only_conversation_list(auth_required=False, user_id=user_id)

    # Logged out → every hub conversation/invitation call would 401 and surface
    # a "Cloud Request Failed" warning (and feed the hub-error suppression
    # window). Return local-only with auth_required, exactly like
    # _start_inbox_catchup skips the same calls at startup.
    from flow_sdk.cli.auth.hub_login import hub_auth_available  # noqa: PLC0415

    if not hub_auth_available():
        return await _local_only_conversation_list(auth_required=True, user_id=user_id)

    # Bulk-read the entire local mirror ONCE as the reconcile cache. This is the
    # only consumer of ``local_index`` — the returned list is the separate,
    # unfiltered ``merged`` below, so output is unaffected. (Must NOT filter by
    # ``created_by``: remote conversations carry the hub owner's id, not the local
    # user's, so a ``created_by`` filter returns nothing — emptying the cache and
    # forcing a per-row get_one + a spurious "stale" verdict for every conv.)
    local_list = await Conversation.get_all({})
    local_index = {c.id: c for c in local_list if c.id}

    hub_convs_result, hub_invs_result = await asyncio.gather(
        hub_get(BuiltinEntityType.CONVERSATION),
        hub_get(BuiltinEntityType.INVITATION, action="pending"),
        return_exceptions=True,
    )

    hub_reachable = True
    auth_required = False

    def _coerce_list(result) -> Optional[list]:
        nonlocal hub_reachable, auth_required
        if isinstance(result, Exception):
            hub_reachable = False
            if "401" in str(result) or "Unauthorized" in str(result):
                auth_required = True
            return None
        if result is None:
            hub_reachable = False
            return None
        return result if isinstance(result, list) else []

    hub_convs = _coerce_list(hub_convs_result) or []
    hub_invs = _coerce_list(hub_invs_result) or []

    # (c) Reconcile hub conversation metadata into the local mirror, and COLLECT
    # the conversations whose messages have drifted (dispatched as one bounded
    # batch AFTER the response is built — see step (f)).
    #
    # Upsert ONLY conversations that actually changed: a row that's already local,
    # already remote, and not hub-stale needs no write. The hub bumps the parent
    # ``updated_date`` on every conversation change (message add/edit/delete,
    # delivery/body status, membership), so ``is_stale`` is a complete change
    # signal — see _should_fetch_messages. Skipping the unchanged majority avoids
    # a per-row get_one + save for every conversation on every list call.
    # conv id -> the hub revision that justified its fetch; the drain stamps it
    # as the new watermark only if the reconcile actually succeeds.
    bg_fetch_pending: dict[str, Optional[datetime]] = {}
    # A per-batch memo so a hub account's many conversations (mostly one
    # shared roster) learn their contacts once, not once per conversation.
    learned_rosters: set[str] = set()
    for hub_conv in hub_convs:
        conv_id = (hub_conv.get("id") or "").strip()
        if not conv_id:
            continue
        # Owner-deleted conversations remain on the hub as audit rows. They
        # are not live sync inputs: deciding message drift before checking
        # deleted_at queued a detached child fetch which recreated the bare
        # local Conversation immediately after this loop deleted it.
        if hub_conv.get("deleted_at"):
            existing = local_index.get(conv_id)
            if existing is not None:
                try:
                    await _hard_delete_local_conversation(existing)
                except Exception as e:  # noqa: BLE001
                    logger.warning("[conv-list] deleted audit cleanup %s failed: %s", conv_id[:8], e)
            continue
        # ``existing`` is the PRE-upsert local copy from the bulk cache — the
        # correct comparison baseline. Capture the fetch decision BEFORE the
        # upsert mutates ``existing.updated_date``.
        existing = local_index.get(conv_id)
        # Parsed once and reused by the fetch gate, the upsert gate and the
        # watermark below — it is the same hub string in all three.
        _hub_updated = Conversation._as_datetime(hub_conv.get("updated_date"))
        _clock_moved = existing is None or Conversation.hub_clock_moved(existing, _hub_updated)
        should_fetch = _should_fetch_messages(existing, hub_conv, clock_moved=_clock_moved)
        # ``created_date`` is hub-authoritative and corruptible locally (a DB
        # rebuild re-stamps it) without ever moving ``updated_date`` — so it can't
        # ride is_stale. Compare it here against the cache (free, in-memory) so the
        # repair branch in _upsert still runs; converged rows match and skip.
        _created_drift = hub_created_drift(existing, hub_conv)
        # Same converging watermark as the fetch gate. With ``is_stale`` here the
        # local metadata write also re-fired on every call for every already-synced
        # conversation — a save + a WS ``data_op`` per conversation per call, which
        # is what made the client re-list the whole Inbox dozens of times per login.
        if existing is None or not existing.remote or _clock_moved or _created_drift:
            try:
                await _upsert_hub_conversation_metadata(
                    hub_conv,
                    someone_typeid,
                    existing=existing,
                    learned_rosters=learned_rosters,
                )
            except Exception as e:  # noqa: BLE001
                logger.warning("[conv-list] upsert conv=%s failed: %s", conv_id[:8], e)
                continue
        if should_fetch:
            # Collect now; dispatch the whole batch off-path at the end so these
            # fetches don't steal event-loop time from the reconcile above.
            bg_fetch_pending[conv_id] = _hub_updated

    # (d) invitations through the new materializer: the hub embeds the
    # target Conversation + first FlowMessage in each invitation, so the
    # local row is the real conv (remote=True) — no synthesized placeholder.
    invitation_conv_ids: set[str] = set()
    for inv in hub_invs:
        try:
            # On the UI path the HTTP response is followed by one local query
            # refetch, so per-entity broadcasts are suppressed while reconciling
            # the batch: emitting every historical invitation one by one
            # continuously reorders Inbox rows and can make an otherwise enabled
            # action physically unclickable until the catch-up finishes. A
            # backend-initiated sweep has no refetch behind it — see
            # ``announce_invitations``.
            _local_inv, conv_id = await _materialize_invitation(
                inv,
                someone_typeid,
                notify=announce_invitations,
            )
            if conv_id:
                invitation_conv_ids.add(conv_id)
        except Exception as e:  # noqa: BLE001
            logger.warning("[conv-list] invitation materialize failed: %s", e)
    await _prune_expired_invitations()

    # (e) Prune step (decision #1c): any local `remote=True` row that did
    # NOT appear in this fetch (neither in hub_convs nor as the target of
    # a pending invitation) means it was deleted hub-side (or the local
    # user lost access). Reconcile by hard-deleting locally so the next
    # render reflects reality.
    pruned_ids: list[str] = []
    if hub_reachable:
        seen_ids = {c.get("id") for c in hub_convs if c.get("id") and not c.get("deleted_at")}
        seen_ids.update(invitation_conv_ids)
        # Re-read local state because the upsert + invitation steps may have
        # added rows that didn't exist when we snapshotted earlier.
        refreshed_local = await Conversation.get_all({})
        for c in refreshed_local:
            if c.remote and c.id and c.id not in seen_ids:
                try:
                    await _hard_delete_local_conversation(c)
                    pruned_ids.append(c.id)
                except Exception as e:  # noqa: BLE001
                    logger.warning("[conv-list] prune %s failed: %s", (c.id or "?")[:8], e)

    # (f) one unread reconcile for the whole batch — invitations materialized
    # in (d) and conversations pruned in (e) both change the projection.
    inbox.touch("conversation-list")

    # return the freshly-merged list.
    merged = await Conversation.get_all({})
    response = ApiSuccessResponse(
        data={
            "conversations": [c.model_dump(mode="json") for c in merged],
            "bg_fetch_dispatched": list(bg_fetch_pending),
            "pruned_ids": pruned_ids,
            "hub_reachable": hub_reachable,
            "auth_required": auth_required,
        }
    )

    # (g) ONLY NOW — after the entire foreground reconcile — kick off the message
    # catch-up for all drifted conversations as ONE bounded, detached batch. The
    # fetches start as the response is sent (never contending with the loop above)
    # and only a few run at once. Their writes heal through the authoritative
    # reconcile in _fetch_conversation_messages and stream in via WS data_op.
    _dispatch_conversation_message_fetches(bg_fetch_pending, someone_typeid)
    return response


@action.post(action_name="conversation-list", types=None)
async def conversation_list() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        return await handle_conversation_list(request_info.someone_typeid)
    except Exception as e:
        logger.error("[flow_message_action] conversation-list error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed: {e}")


@action.post(action_name="conversation-summary", types=None)
async def conversation_summary() -> ApiResponse:
    """Plain-text summary of one conversation (header + one line per message).

    Thin wrapper over ``Conversation.summary()`` — no LLM, no hub calls. Same
    auth gate as ``conversation-message-sync``: require a local Conversation
    row for the id so an authenticated caller can't summarize an arbitrary id.
    """
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        body = await request_info.get_post_data() or {}
        conv_id = (body.get("conversation_id") or "").strip()
        if not conv_id:
            return ApiFailResponse(message="conversation_id required")
        conv = await Conversation.get_one({"id": conv_id})
        if conv is None:
            return ApiFailResponse(message="conversation not found", status_code=404)
        return ApiSuccessResponse(data={"conversation_id": conv_id, "summary": await conv.summary()})
    except Exception as e:
        logger.error("[flow_message_action] conversation-summary error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed: {e}")


async def handle_conversation_sync(someone_typeid: str) -> ApiResponse:
    """**Deprecated** — delegates to ``handle_conversation_list``.

    Kept for back-compat with external SDK callers; new code should call the
    ``conversation-list`` action directly. The legacy response shape
    ``{invitations, flow_messages}`` is reconstructed from the new payload.
    """
    resp = await handle_conversation_list(someone_typeid)
    if not isinstance(resp, ApiSuccessResponse):
        return resp
    data = resp.data or {}
    return ApiSuccessResponse(
        data={
            "invitations": 0,  # legacy shape; placeholder count
            "flow_messages": len(data.get("bg_fetch_dispatched", []) or []),
        }
    )


async def _announce_new_invitations(fresh_invitations: list) -> None:
    """OS notification for NEWLY arrived invitations addressed to this viewer.

    The Layer-2 invitation consumer of the generic notification service: a
    pending invite rides the invitation op — it never reaches the inbound
    flow_message notify path. One banner per new invite; clicking opens the
    Inbox (where Accept lives). Re-syncs of already-known invitations stay
    silent (callers pass only newly-materialized rows). Failure-isolated:
    a notify hiccup never fails the sync that discovered the invitation.
    """
    if not fresh_invitations:
        return
    with contextlib.suppress(Exception):
        from flow_sdk.inbox import invitation_is_pending, viewer_email
        from flow_sdk.notifications import notify_desktop

        email = viewer_email()
        now = datetime.now(UTC)
        for local_inv in fresh_invitations:
            if not invitation_is_pending(local_inv, email, now):
                continue
            inviter = (getattr(local_inv, "inviter_name", None) or "").strip() or "Someone"
            if local_inv.target_type and local_inv.target_id:
                body = f"Invitation to join {local_inv.target_name or local_inv.target_type}"
            else:
                body = (local_inv.message or "").strip() or "New conversation request"
            await notify_desktop(
                "invitation",
                title=f"{inviter} invited you",
                body=body,
                click_target={"view_type": "inbox"},
            )


def _invitation_matches_target(hub_inv: dict, target_id: str | None) -> bool:
    """Whether one pending invitation points at the caller's known target.

    Conversation invitations carry an embedded ``conversation``; generic
    membership invitations carry ``target``. ``target_url_path`` keeps older
    hub payloads targetable without weakening the exact-id comparison.
    """
    if not target_id:
        return True
    conversation = hub_inv.get("conversation")
    if isinstance(conversation, dict) and conversation.get("id") == target_id:
        return True
    target = hub_inv.get("target")
    if isinstance(target, dict) and target.get("id") == target_id:
        return True
    target_path = str(hub_inv.get("target_url_path") or "").rstrip("/")
    return bool(target_path) and target_path.rsplit("/", 1)[-1] == target_id


async def handle_invitation_sync(someone_typeid: str, *, target_id: str | None = None) -> ApiResponse:
    """Pull pending invitations only — no inbox-fetch.

    Realtime callers (vitest ping-pong, mobile poll-then-accept) need to
    discover a fresh invitation quickly. ``conversation-sync`` also runs the
    cursor-based inbox-fetch, which retries 404'd bundle downloads from
    prior FlowMessages and adds seconds of latency. This variant skips
    that, returning the moment invitations are mirrored.
    """
    if not hub_base_url():
        return ApiFailResponse(message="Hub not configured")

    inv_count = 0
    invitations = await hub_get(BuiltinEntityType.INVITATION, action="pending") or []
    if not isinstance(invitations, list):
        invitations = []
    if target_id:
        invitations = [inv for inv in invitations if _invitation_matches_target(inv, target_id)]

    # Snapshot known invitation ids BEFORE materializing so we can tell a
    # newly-arrived invitation (→ OS notification below) from a re-synced one.
    known_inv_ids: set[str] = set()
    with contextlib.suppress(Exception):
        from flow_sdk.builtin.invitation import Invitation as _LocalInvitation
        from flow_sdk.db.drivers.query import QueryFilter as _QF

        known_inv_ids = {row.id for row in await _LocalInvitation.get_all(_QF(type=BuiltinEntityType.INVITATION.value))}

    fresh_invitations = []
    for inv in invitations:
        try:
            local_inv, _conv_id = await _materialize_invitation(inv, someone_typeid)
            if local_inv:
                inv_count += 1
                if local_inv.id not in known_inv_ids:
                    fresh_invitations.append(local_inv)
        except Exception as e:
            logger.warning("[invitation-sync] upsert failed: %s", e)
    await _prune_expired_invitations()
    inbox.touch("invitation-sync")

    await _announce_new_invitations(fresh_invitations)
    return ApiSuccessResponse(data={"invitations": inv_count})


async def _prune_expired_invitations() -> None:
    """Delete local mirrors of hub invitations that have expired unaccepted.

    The hub keeps expired Invitation rows as an audit trail but no longer
    returns them from ``pending``, so nothing ever updates the local mirror
    again — without this prune a dead invitation sits in the inbox forever
    (the v0.2.9x "10 phantom Organization invitations" incident). Only
    ``remote`` (hub-mirrored) rows are touched: the hub's audit copy stays;
    accepted rows are memberships now and are never invitations to prune.
    """
    from flow_sdk.builtin.invitation import Invitation as LocalInvitation  # noqa: PLC0415

    try:
        local_invs = await LocalInvitation.get_all({})
    except Exception as e:  # noqa: BLE001
        logger.warning("[invitation-sync] prune scan failed: %s", e)
        return
    for inv in local_invs or []:
        try:
            if not getattr(inv, "remote", False) or inv.accepted or not inv.is_expired():
                continue
            await inv.delete()
            logger.info("[invitation-sync] pruned expired invitation %s", (inv.id or "")[:8])
        except Exception as e:  # noqa: BLE001
            logger.warning("[invitation-sync] prune failed for %s: %s", (inv.id or "")[:8], e)


@action.post(action_name="conversation-sync", types=None)
async def conversation_sync() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        return await handle_conversation_sync(request_info.someone_typeid)
    except Exception as e:
        logger.error("[flow_message_action] conversation-sync error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed: {e}")


@action.post(action_name="conversation-message-sync", types=None)
async def conversation_message_sync() -> ApiResponse:
    """Targeted per-conversation message catch-up.

    The conversation view calls this on open to pull new/changed hub messages
    for ONE conversation, instead of running the global conversation-list
    pipeline. Awaits the optimized ``_fetch_conversation_messages``
    (children-list route in a single request + ``is_stale`` new∪changed diff),
    so by the time it returns the local live query already reflects the hub
    state — the UI doesn't need a per-message backfill loop.
    """
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        body = await request_info.get_post_data() or {}
        conv_id = (body.get("conversation_id") or "").strip()
        if not conv_id:
            return ApiFailResponse(message="conversation_id required")
        # A bridge reconnect can miss the assignment frame that normally
        # materializes this row. Heal that exact cache miss from the hub before
        # syncing children. The hub's GET is the authorization gate: it only
        # returns a conversation the logged-in user may read, so a guessed id
        # cannot trigger a local write.
        local_conv = await Conversation.get_one({"id": conv_id})
        if local_conv is None:
            hub_conv = await hub_get(BuiltinEntityType.CONVERSATION, conv_id)
            if not isinstance(hub_conv, dict) or not hub_conv.get("id"):
                return ApiFailResponse(message="conversation not found", status_code=404)
            local_conv = await _upsert_hub_conversation_metadata(
                hub_conv,
                request_info.someone_typeid,
                existing=None,
            )
            if local_conv is None:
                return ApiFailResponse(message="conversation not found", status_code=404)
        # A local-only conversation (remote=False) has no hub counterpart —
        # asking the hub is guaranteed to fail (and its 401 surfaces as a
        # spurious "Cloud sign-in expired" toast). Nothing to catch up.
        if not local_conv.remote:
            return ApiSuccessResponse(data={"conversation_id": conv_id, "skipped": "local-only"})
        await _fetch_conversation_messages(conv_id, request_info.someone_typeid)
        # Recursive-share catch-up: pull shared-context children (e.g. the
        # shared markdown) + their comments so a recipient sees the doc and
        # everyone's comments without a live subscription.
        await _sync_shared_context_subtree(conv_id, request_info.someone_typeid)
        return ApiSuccessResponse(data={"conversation_id": conv_id})
    except Exception as e:
        logger.error("[flow_message_action] conversation-message-sync error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed: {e}")


@action.post(action_name="invitation-sync", types=None)
async def invitation_sync() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        body = await request_info.get_post_data() or {}
        target_id = str(body.get("target_id") or body.get("conversation_id") or "").strip() or None
        return await handle_invitation_sync(request_info.someone_typeid, target_id=target_id)
    except Exception as e:
        logger.error("[flow_message_action] invitation-sync error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed: {e}")


async def handle_invitation_accept(body: dict, someone_typeid: str) -> ApiResponse:
    """Accept a pending invitation on the hub and download just the unlocked bundle.

    Three steps, no broad inbox sync:
      1. POST hub ``/members/accept`` — grants reader role on the linked FlowMessage.
      2. Mark the local Invitation as accepted so the strip's pending block
         drops the row on its next refetch.
      3. Targeted bundle download for the just-unlocked FlowMessage. ``unpack_bundle``
         materializes the local Conversation + appends pointers to its
         ``conversation.jsonl``. The strip's local refetch then sees the new
         Conversation row.

    Catching up on other accessible FlowMessages is the strip "Refresh" button's
    job (``conversation-sync`` action) — running it here would redownload every
    accessible bundle and double the latency.
    """
    inv_id = (body.get("invitation_id") or "").strip()
    if not inv_id:
        return ApiFailResponse(message="invitation_id required")

    # Hub exposes accept as GET /api/v1/graph/members/accept?invitation-id=X.
    from flow_sdk.utils.hub import hub_base_url as _hub_base

    base = _hub_base()
    if not base:
        return ApiFailResponse(message="Hub not configured")

    accept_url = f"{base}/api/v1/graph/members/accept"
    linked_fm_id: Optional[str] = None
    linked_conv_id: Optional[str] = None
    try:
        from flow_sdk.cloud_client import ApiConfig, FlowpadClient

        async with FlowpadClient(ApiConfig.from_env()) as client:
            resp = await client.request(
                "GET",
                accept_url,
                params={"invitation-id": inv_id},
                timeout=10,
            )
        # Hub responses we treat as "accept succeeded, run local cleanup":
        #   200 — JSON success: ``data`` carries the chosen target typeid.
        #   302 — post-accept landing redirect: ``Location`` points at
        #         ``/flow_message/<id>`` or ``/conversation/<id>``. The hub
        #         became browser-friendly and redirects the user to the
        #         unlocked entity after a successful accept. Verified on
        #         2026-05-28 with a real invitation against app.flowpad.ai.
        #   409 — already accepted (recipient clicked the email link first).
        #         No usable body, but server-side state is what we want and
        #         local cleanup still has work to do (mark accepted, sync).
        #
        # A 302 from this endpoint ALWAYS means the hub bounced us to
        # ``/login.html`` because the request was unauthenticated — the
        # accept did NOT execute. Probed against app.flowpad.ai on
        # 2026-05-28: 302 → ``/login.html?target_path=...`` for both
        # missing and invalid Authorization headers. Earlier this code
        # accepted 302 as success and ran local cleanup, which wrote
        # ``accepted=True`` locally for an invitation the hub never
        # accepted — causing every downstream conversation-scoped call to
        # return 401 ("no valid access for role ['member']").
        if resp.status_code not in (200, 409):
            if resp.status_code in (301, 302, 303, 307, 308):
                location = resp.headers.get("location") or resp.headers.get("Location") or ""
                low = location.lower()
                # A redirect to a login page IS the unauthenticated bounce
                # (e.g. app.flowpad.ai → /login.html). The accept did NOT run.
                if "login" in low:
                    return ApiFailResponse(
                        message=(
                            "Accept failed: hub redirected us to login (request was "
                            f"unauthenticated). location={location[:200]}"
                        ),
                    )

                # Otherwise this hub bounces a SUCCESSFUL accept to the target's
                # page — the role was granted. The target is either the
                # conversation (/conversation/<id>) or the landing FlowMessage
                # (/flow_message/<id>); both mean success. Extract the id and
                # fall through to the normal post-accept resolution (the
                # FlowMessage path resolves its parent conv below).
                def _id_after(seg: str) -> Optional[str]:
                    if seg in location:
                        return location.split(seg)[1].split("/")[0].split("?")[0].split("#")[0]
                    return None

                if _id_after("/conversation/"):
                    linked_conv_id = _id_after("/conversation/")
                elif _id_after("/flow_message/"):
                    linked_fm_id = _id_after("/flow_message/")
                else:
                    # A non-login redirect to any OTHER entity landing — e.g.
                    # ``/skill/<id>`` when the accepted invitation's chosen
                    # target is a shared ASSET rather than a conversation — is
                    # still a SUCCESSFUL accept: the hub granted the role. There
                    # is no conversation to join; fall through so the invitation
                    # is marked accepted and the asset target is mirrored
                    # locally (the membership-target branch below). Only a
                    # ``login`` bounce (handled above) means the accept failed.
                    logger.info(
                        "[invitation-accept] accept redirected to a non-conversation entity landing (asset target): %s",
                        location[:160],
                    )
            elif resp.status_code in (404, 410):
                # Hub says the invitation is gone (404) or expired (410): the
                # local mirror is an orphan (local id == hub id, so a 404 here
                # means the hub node no longer exists). Self-heal the stale row
                # and return the 410 {gone} signal. Any OTHER status (5xx, 401,
                # transport) is transient — fall through, do NOT delete.
                return await _self_heal_gone_invitation(inv_id, context="invitation-accept")
            else:
                return ApiFailResponse(message=f"Accept failed ({resp.status_code}): {resp.text[:200]}")
        if resp.status_code == 409:
            logger.info("[invitation-accept] hub returned 409 (already accepted) — running local cleanup")
        # Resolve the chosen target's typeid. Three response shapes to handle:
        #  - 200 + JSON body — ``data`` carries the typeid (string or dict).
        #  - 302 + Location header — no JSON body; the entity id lives in the
        #    Location path (``/flow_message/<id>`` or ``/conversation/<id>``).
        #  - 409 — already accepted; sometimes ships no body. We try both
        #    shapes below and fall through if neither yields a target.
        try:
            target = None
            body_text = (resp.text or "").strip()
            if body_text.startswith(("{", "[")):
                target = (resp.json() or {}).get("data")
            fm_prefix = f"{BuiltinEntityType.FLOW_MESSAGE.value}-"
            conv_prefix = f"{BuiltinEntityType.CONVERSATION.value}-"
            if isinstance(target, str):
                if target.startswith(fm_prefix):
                    linked_fm_id = target[len(fm_prefix) :]
                elif target.startswith(conv_prefix):
                    linked_conv_id = target[len(conv_prefix) :]
            elif isinstance(target, dict):
                t_type = (target.get("type") or "").strip()
                t_id = (target.get("id") or target.get("identifier") or "").strip()
                if t_type == BuiltinEntityType.FLOW_MESSAGE.value and t_id:
                    linked_fm_id = t_id
                elif t_type == BuiltinEntityType.CONVERSATION.value and t_id:
                    linked_conv_id = t_id
            # 302 success: parse the Location header. Path shapes we expect:
            # ``/flow_message/<id>`` (FM landing) or ``/conversation/<id>``
            # (legacy/conv landing). Scan segments so a SUBPATH prefix
            # (e.g. ``/app/...``) doesn't break the match.
            if not linked_fm_id and not linked_conv_id:
                location = resp.headers.get("location") or resp.headers.get("Location") or ""
                if location:
                    from urllib.parse import urlparse  # noqa: PLC0415

                    path = urlparse(location).path or ""
                    parts = [p for p in path.split("/") if p]
                    for i, seg in enumerate(parts[:-1]):
                        if seg == BuiltinEntityType.FLOW_MESSAGE.value:
                            linked_fm_id = parts[i + 1]
                            break
                        if seg == BuiltinEntityType.CONVERSATION.value:
                            linked_conv_id = parts[i + 1]
                            break
            # When we only have the FlowMessage id, fetch its parent conv id
            # so the join + msg-sync path runs (same as the email-accept flow).
            # Hub FMs don't expose a top-level ``conversation_id`` field — the
            # parent conv lives as a typeid in ``shared_context_entities``.
            if linked_fm_id and not linked_conv_id:
                try:
                    fm_data = await hub_get(BuiltinEntityType.FLOW_MESSAGE, linked_fm_id)
                    if isinstance(fm_data, dict):
                        # 1. Top-level field (older shape / direct mirror).
                        cid = (fm_data.get("conversation_id") or "").strip()
                        # 2. ``shared_context_entities`` (canonical shape).
                        if not cid:
                            conv_prefix_str = f"{BuiltinEntityType.CONVERSATION.value}-"
                            for raw in fm_data.get("shared_context_entities") or []:
                                s = raw if isinstance(raw, str) else str(raw)
                                if s.startswith(conv_prefix_str):
                                    cid = s[len(conv_prefix_str) :]
                                    break
                        if cid:
                            linked_conv_id = cid
                except Exception as fetch_err:
                    logger.debug("[invitation-accept] fm lookup for conv resolution failed: %s", fetch_err)
        except Exception as parse_err:
            logger.warning("[invitation-accept] could not parse target typeid: %s", parse_err)
    except Exception as e:
        return ApiFailResponse(message=f"Accept transport error: {e}")

    # Conversation target → join the hub-side conversation so we enter
    # ``participants`` and start receiving WS fanout. Then GET the conv from
    # the hub and save it locally so the UI's conversation view has something
    # to render the moment ``invitation-accept`` returns — without racing the
    # bridge's async ``_handle_conversation_op`` materialization.
    conversation_synced = False
    if linked_conv_id:
        try:
            from flow_sdk.cli.auth.credentials import load_credentials  # noqa: PLC0415
            from flow_sdk.cloud_client.client import ApiConfig, FlowpadClient  # noqa: PLC0415

            creds = load_credentials()
            if creds and creds.api_key:
                async with FlowpadClient(ApiConfig.from_env(), api_key=creds.api_key) as client:
                    await client.post(f"/graph/conversation/{linked_conv_id}/join", {})
                    hub_conv = await client.get(f"/graph/conversation/{linked_conv_id}")
                if isinstance(hub_conv, dict) and hub_conv.get("id"):
                    participants = hub_conv.get("participants")
                    try:
                        async with FlowpadClient(ApiConfig.from_env(), api_key=creds.api_key) as client:
                            members = await client.get(f"/graph/conversation/{linked_conv_id}/members")
                        if isinstance(members, dict):
                            for key in ("data", "members", "items", "results"):
                                if isinstance(members.get(key), list):
                                    members = members[key]
                                    break
                        if isinstance(members, list) and (members or not isinstance(participants, list)):
                            hub_conv = {**hub_conv, "participants": members}
                            participants = members
                    except Exception as roster_err:  # noqa: BLE001
                        logger.debug(
                            "[invitation-accept] members lookup failed for conv=%s: %s",
                            linked_conv_id[:8],
                            roster_err,
                        )
                    if isinstance(participants, list):
                        await _learn_address_book(participants)
                    await _upsert_hub_conversation_metadata(hub_conv, someone_typeid)
                # Pull the inviter's pre-accept messages — the hub WS only
                # fanouts from join-time forward, so without this the first
                # message stays invisible until a manual refresh.
                # Accept is the membership + metadata boundary. Bundle bytes
                # stay on the explicit Download/staging rail in the message UI;
                # pulling and unpacking them here made the Accept request block
                # on filesystem work before the user asked to download.
                await _sync_conversation_messages(
                    linked_conv_id,
                    someone_typeid,
                    download_bundles=False,
                )
                # ...but the bytes still have to arrive. Accept is the only pass
                # that ever sees the pre-accept messages (see above), so skipping
                # the download here skipped it entirely — the payload never
                # landed and the chip stayed in its pre-download hidden state.
                # Pull it right AFTER the response instead: same work, still off
                # the request path, so accept keeps its latency.
                _schedule_conversation_bundle_pull(linked_conv_id)
                conversation_synced = True
        except Exception as e:
            logger.warning("[invitation-accept] hub join+materialize failed: %s", e, exc_info=True)

    # Local accept transition (best-effort): mark the VERIFIED invitation
    # preview read + the Invitation accepted, then reconcile the unread
    # projection — one idempotent path (repeat / 409 accepts included).
    membership_target: Optional["Invitation"] = None
    try:
        from flow_sdk.builtin.invitation import Invitation as LocalInvitation
        from flow_sdk.inbox import accept_mark_preview_read

        existing = await LocalInvitation.get_one({"id": inv_id})
        if existing:
            await accept_mark_preview_read(
                existing,
                conversation_id=linked_conv_id,
                linked_fm_id=linked_fm_id,
                owner=someone_typeid,
            )
            if existing.target_type and existing.target_id:
                membership_target = existing
    except Exception as e:
        logger.warning("[invitation-accept] local update failed: %s", e)

    # Membership invitation (organization / team): the hub accept granted the
    # role — that IS the membership, no conversation/bundle to pull. Mirror the
    # target locally as remote=True so the Organization tab / member list shows
    # it immediately, and notify so the UI repaints.
    if membership_target is not None and membership_target.target_type == BuiltinEntityType.TASK.value:
        # Task invitation: pull the real task (+ its group parent, if it has one)
        # from the hub — the generic membership mirror below only carries
        # name/icon and would materialize a husk.
        try:
            from flow_sdk.app.actions.task_receive import (  # noqa: PLC0415
                materialize_accepted_task_invitation,
            )

            child_task = await materialize_accepted_task_invitation(membership_target.target_id, someone_typeid)
            if child_task is not None:
                await child_task.notify_updated()
        except Exception as e:  # noqa: BLE001
            logger.warning("[invitation-accept] task target materialize failed: %s", e)
    elif membership_target is not None:
        try:
            cls = _membership_cls(membership_target.target_type)
            from flow_sdk.app.actions.membership_sync import (  # noqa: PLC0415
                materialize_remote_membership_entity,
            )

            target_payload = {
                "id": membership_target.target_id,
                "name": membership_target.target_name,
            }
            if membership_target.target_type == BuiltinEntityType.PROJECT.value:
                project_payload_error: str | None = None
                try:
                    from flow_sdk.cli.auth.credentials import load_credentials  # noqa: PLC0415
                    from flow_sdk.cloud_client.client import ApiConfig, FlowpadClient  # noqa: PLC0415

                    creds = load_credentials()
                    if not creds or not creds.api_key:
                        project_payload_error = "cloud login required"
                    else:
                        async with FlowpadClient(ApiConfig.from_env(), api_key=creds.api_key) as client:
                            hub_project = await client.get(f"/graph/project/{membership_target.target_id}")
                        if isinstance(hub_project, dict) and hub_project.get("id"):
                            target_payload.update(hub_project)
                        else:
                            project_payload_error = "hub project payload was empty or malformed"
                except Exception as fetch_err:  # noqa: BLE001
                    project_payload_error = str(fetch_err)
                if project_payload_error:
                    logger.warning(
                        "[invitation-accept] project payload fetch failed for %s: %s",
                        membership_target.target_id,
                        project_payload_error,
                    )
                    return ApiFailResponse(
                        message=(
                            "Accepted invitation, but failed to fetch shared project metadata; "
                            "local project was not materialized. Retry after cloud connectivity "
                            f"and login are restored: {project_payload_error[:160]}"
                        )
                    )
            ent = await materialize_remote_membership_entity(
                cls,
                target_payload,
                someone_typeid,
            )
            if ent is not None:
                if (
                    membership_target.target_type == BuiltinEntityType.PROJECT.value
                    and getattr(ent, "origin", None) is not None
                ):
                    try:
                        await ent.setup_from_git_origin()
                    except Exception as setup_err:  # noqa: BLE001
                        logger.warning(
                            "[invitation-accept] project Git setup failed: %s",
                            setup_err,
                            exc_info=True,
                        )
                        return ApiFailResponse(
                            message=(
                                "Invitation accepted, but the project could not be set up locally: "
                                f"{str(setup_err)[:240]}"
                            ),
                            status_code=400,
                        )
                await ent.notify_updated()
        except Exception as e:  # noqa: BLE001
            logger.warning("[invitation-accept] membership target materialize failed: %s", e)

    # The invitation now ships with the Conversation embedded, so the local
    # SDK already has the real conversation row pre-accept. Nothing to clean
    # up here — the invitation-kind FlowMessage stays as the first message
    # in the conversation (it IS the preview); subsequent bundle downloads
    # append after it.

    # A resolved parent conversation was synchronized above, and its bundle
    # bytes deliberately remain on the explicit user-owned Download rail.
    # Retain the targeted fallback only for a FlowMessage target that had no
    # resolvable parent conversation.
    bundle_unpacked = False
    if linked_fm_id and not conversation_synced:
        try:
            hub_fm = await hub_get(BuiltinEntityType.FLOW_MESSAGE, linked_fm_id)
            attachment_filename = ((hub_fm or {}).get("attachment_filename") or "").strip()
            if attachment_filename:
                bundle_unpacked = await _download_and_unpack_bundle(
                    linked_fm_id,
                    attachment_filename,
                    body_status=(hub_fm or {}).get("body_status"),
                    hub_updated=(hub_fm or {}).get("updated_date"),
                )
        except Exception as e:
            logger.warning("[invitation-accept] bundle download failed: %s", e)

    # Live UI refresh: fire an explicit ``OperationType.UPDATE`` for the
    # Conversation entity. The per-step sniffer EVENTs logged above as
    # ``[hook_op] Unhandled event`` don't invalidate the UI's
    # ``useEntity<Conversation>`` React-Query cache. ``notify_updated``
    # dispatches a ``DataOpMessage(op=UPDATE)`` which IS what useEntity
    # listens for.
    # The per-step events fired above (materialize, sync) don't all carry the
    # final ``shared_context_entities`` value (bundle-unpack stamps task/spec
    # onto the conv last). Fire one explicit UPDATE on the now-settled
    # Conversation so subscribers see the final state in one shot.
    if linked_conv_id:
        try:
            from flow_sdk.builtin.conversation import Conversation  # noqa: PLC0415

            conv_final = await Conversation.get_one({"id": linked_conv_id})
            if conv_final is not None:
                try:
                    await _learn_address_book(conv_final.members or [])
                except Exception as learn_err:  # noqa: BLE001
                    logger.debug(
                        "[invitation-accept] final contact learn failed for conv=%s: %s",
                        linked_conv_id[:8],
                        learn_err,
                    )
                await conv_final.notify_updated()
        except Exception as e:
            logger.debug("[invitation-accept] post-accept conv notify failed: %s", e)

    return ApiSuccessResponse(
        data={
            "invitation_id": inv_id,
            "flow_message_id": linked_fm_id,
            "conversation_id": linked_conv_id,
            "bundle_unpacked": bundle_unpacked,
        }
    )


@action.post(action_name="invitation-accept", types=None)
async def invitation_accept() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        body = await request_info.get_post_data() or {}
        return await handle_invitation_accept(body, request_info.someone_typeid)
    except Exception as e:
        logger.error("[flow_message_action] invitation-accept error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed: {e}")
