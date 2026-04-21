"""HTTP actions for FlowMessage file transport.

  POST /api/v1/graph/flow-message-upload      — upload .flowmsg (multipart, global action)
  POST /api/v1/graph/flow-message-create      — create task+spec+conv+FlowMessage locally, no email/git
  GET  /api/v1/graph/flow_message/{id}/create-and-download-local-flowmsg  — download .flowmsg (entity-scoped)
  GET  /api/v1/graph/flow_message/{id}/open   — deep-link: fetch from hub and open IncomingTaskDialog
"""
import json as _json
import logging
import os
import re
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Optional

from flow_sdk.actions.action_registry import action
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
from flow_sdk.builtin.spec import Spec
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.builtin.task import Task
from flow_sdk.builtin.user import User
from flow_sdk.config import FLOW_HOME
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.fs_records.conversation_record import ConversationRecord
from flow_sdk.fs_records.flow_message_bundle import FlowMessageExistsError
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse, ApiResponse
from flow_sdk._compat import UTC
from flow_sdk.utils.hub import hub_get

logger = logging.getLogger(__name__)


def _meaningful_name(title: str) -> str:
    name = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return name[:60] or "untitled"


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

    task_id = next((c.id for c in fm.context if c.type == BuiltinEntityType.TASK.value), None)
    conv_id = next((c.id for c in fm.context if c.type == BuiltinEntityType.CONVERSATION.value), None)

    return ApiSuccessResponse(data={
        "message_id": fm.id,
        "task_id": task_id,
        "conversation_id": conv_id,
        "was_new_task": True,
    })


async def handle_create_task_bundle(
    spec_title: str,
    spec_content: str,
    task_title: str,
    someone_typeid: str,
    message: Optional[str] = None,
    team_space_id: Optional[str] = None,
) -> ApiResponse:
    """Create Task + Spec + Conversation + FlowMessage locally (no git push, no email).

    Returns flow_message_id so the caller can immediately trigger a .flowmsg download.
    """
    local_user = await User.get_one({"uname": "local"})
    sender_id: Optional[str] = local_user.id if local_user else None
    sender_name: str = (local_user.name or local_user.email or "") if local_user else ""

    # 1. Create Spec
    spec = Spec.model_validate({
        "title": spec_title,
        "content": spec_content,
        "spec_type": "plan",
        "author_id": sender_id,
    })
    spec.id = Spec.allocate_id(spec.model_dump())
    spec = await spec.save(someone_typeid)

    # 2. Create Task
    task = Task.model_validate({
        "title": task_title,
        "spec_id": spec.id,
        "shared_by_id": sender_id,
        "metadata": {"team_space_id": team_space_id} if team_space_id else None,
    })
    task.id = Task.allocate_id(task.model_dump())
    task = await task.save(someone_typeid)

    # 3. Create Conversation + conversation.jsonl under FLOW_HOME/tasks/<slug>-<id>/
    task_dir = FLOW_HOME / "tasks" / f"{_meaningful_name(task_title)}-{task.id[:8]}"
    task_dir.mkdir(parents=True, exist_ok=True)
    jsonl_path = task_dir / "conversation.jsonl"
    jsonl_path.touch()

    conv = Conversation.model_validate({
        "task_id": task.id,
        "data_path": str(jsonl_path),
        "message_count": 0,
    })
    conv.id = Conversation.allocate_id(conv.model_dump())
    conv = await conv.save(someone_typeid)
    await task.attach_child(conv)

    rec = ConversationRecord.from_jsonl(jsonl_path, task.id, conv.id)
    rec.save()
    rec.link_to_parent_record()

    task.conversation_id = conv.id
    task = await task.save(someone_typeid)

    # 4. Create FlowMessage record
    context = [
        TypeId(type=BuiltinEntityType.TASK.value, id=task.id),
        TypeId(type=BuiltinEntityType.CONVERSATION.value, id=conv.id),
    ]

    fm = FlowMessage.model_validate({
        "text": message or f"Task: {task_title}",
        "context": context,
        "attachment": [],
        "sender_id": sender_id,
        "sender_name": sender_name,
    })
    fm.id = FlowMessage.allocate_id(fm.model_dump())
    fm.attachment = [
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.SPEC.value, id=spec.id))),
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.TASK.value, id=task.id))),
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.CONVERSATION.value, id=conv.id))),
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.FLOW_MESSAGE.value, id=fm.id))),
    ]
    fm = await fm.save(someone_typeid)

    # Append pointer to conversation
    bundle_ts = datetime.now(UTC).isoformat()
    rec.append_message_pointer(fm.id, bundle_ts)
    conv.message_ids = _json.dumps([{"message_id": fm.id, "timestamp": bundle_ts}])
    conv.message_count = 1
    conv = await conv.save(someone_typeid)

    return ApiSuccessResponse(data={
        "flow_message_id": fm.id,
        "task_id": task.id,
        "conversation_id": conv.id,
        "spec_id": spec.id,
    })


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
        overwrite = overwrite_qp.lower() in ("true", "1", "yes")
        return await handle_upload_flow_message(upload_file, overwrite)
    except Exception as e:
        logger.error(f"[flow_message_action] upload error: {e}", exc_info=True)
        return ApiFailResponse(message=f"Upload failed: {str(e)}")


@action.post(action_name="flow-message-create", types=None)
async def create_task_bundle() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info:
            return ApiFailResponse(message="No request info found")
        if not request_info.someone_typeid:
            return ApiFailResponse(message="No authenticated user in request context")

        body = await request_info.get_post_data() or {}
        spec_title = (body.get("spec_title") or "").strip()
        if not spec_title:
            return ApiFailResponse(message="spec_title is required")

        return await handle_create_task_bundle(
            spec_title=spec_title,
            spec_content=(body.get("spec_content") or "").strip(),
            task_title=(body.get("task_title") or spec_title).strip(),
            someone_typeid=request_info.someone_typeid,
            message=(body.get("message") or "").strip() or None,
            team_space_id=(body.get("team_space_id") or "").strip() or None,
        )
    except Exception as e:
        logger.error(f"[flow_message_action] create-task-bundle error: {e}", exc_info=True)
        return ApiFailResponse(message=f"Failed to create task bundle: {str(e)}")


@action.get(action_name="open", types=[BuiltinEntityType.FLOW_MESSAGE.value])
async def open_flow_message() -> ApiResponse:
    """Deep-link handler: fetch FlowMessage from hub and redirect to IncomingTaskDialog.

    Only triggers the git pull/clone flow if the FlowMessage has REPO attachments.
    The first REPO attachment URL is passed as project_url; if none exist the UI
    navigates directly to the task without showing the pull/clone dialog.
    """
    from flow_sdk.builtin.flow_message import AttachmentType
    from flow_sdk.server.routes.notify import handle_notification_deep_link

    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        return ApiFailResponse(message="No request info found", status_code=400)

    flow_message_id = str(request_info.target_entity_typeid.id)
    data = await hub_get(BuiltinEntityType.FLOW_MESSAGE, flow_message_id)
    meta = (data or {}).get("metadata") or {}

    # Extract the first REPO attachment URL — only this triggers the git flow.
    raw_attachments = (data or {}).get("attachment") or []
    repo_url = next(
        (a["data"] for a in raw_attachments
         if isinstance(a, dict) and a.get("attachment_type") == AttachmentType.REPO.value and a.get("data")),
        "",
    )

    task_id = (meta.get("task_id") or (data or {}).get("task_id") or "").strip()
    attachment_filename = ((data or {}).get("attachment_filename") or "").strip()

    # No REPO attachment — if the task doesn't exist locally and a bundle is available, unpack it.
    if not repo_url and task_id and attachment_filename:
        try:
            existing = await Task.get_one({"id": task_id})
            if not existing:
                local_user = await User.get_one({"uname": "local"})
                local_user_id = local_user.id if local_user else ""
                bundle_bytes = await hub_get(
                    BuiltinEntityType.FLOW_MESSAGE, flow_message_id, "fs", f"download/{attachment_filename}", raw=True
                )
                if bundle_bytes:
                    with tempfile.NamedTemporaryFile(suffix=".flowmsg", delete=False) as tmp:
                        tmp_path = Path(tmp.name)
                        tmp.write(bundle_bytes)
                    try:
                        from flow_sdk.fs_records.flow_message_bundle import unpack_bundle
                        await unpack_bundle(tmp_path, local_user_id, overwrite=False)
                    except FlowMessageExistsError:
                        pass
                    finally:
                        tmp_path.unlink(missing_ok=True)
        except Exception as e:
            logger.warning("[open_flow_message] failed to materialize task (non-fatal): %s", e)

    return await handle_notification_deep_link(
        task_id=task_id,
        project_url=repo_url,
        branch=(meta.get("branch") or (data or {}).get("branch") or "").strip(),
        repo_id=(meta.get("repo_id") or (data or {}).get("repo_id") or "").strip(),
        sender_name=(meta.get("sender_name") or (data or {}).get("sender_name") or "").strip(),
        task_title=(meta.get("task_title") or meta.get("spec_title") or (data or {}).get("task_title") or "").strip(),
    )


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
# Inbox actions
# ---------------------------------------------------------------------------

_LAST_FETCH_PATH = FLOW_HOME / ".inbox_last_fetch.json"


def _load_last_fetch() -> Optional[str]:
    """Return ISO timestamp of last successful hub fetch, or None."""
    try:
        if _LAST_FETCH_PATH.exists():
            return _json.loads(_LAST_FETCH_PATH.read_text()).get("last_fetch")
    except Exception:
        pass
    return None


def _save_last_fetch(ts: str) -> None:
    _LAST_FETCH_PATH.parent.mkdir(parents=True, exist_ok=True)
    _LAST_FETCH_PATH.write_text(_json.dumps({"last_fetch": ts}))


async def _download_and_unpack_bundle(fm_id: str, attachment_filename: str) -> bool:
    """Download the .flowmsg bundle from the hub and unpack it locally.

    Returns True if the bundle was successfully unpacked, False otherwise.
    """
    from flow_sdk.fs_records.flow_message_bundle import FlowMessageExistsError, unpack_bundle
    logger.info("[bundle] downloading fm=%s file=%s", fm_id, attachment_filename)
    bundle_bytes = await hub_get(
        BuiltinEntityType.FLOW_MESSAGE, fm_id, "fs", f"download/{attachment_filename}", raw=True
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
        logger.info("[bundle] unpacking fm=%s size=%d", fm_id, len(bundle_bytes))
        await unpack_bundle(tmp_path, local_user_id, overwrite=False)
        logger.info("[bundle] unpack success fm=%s", fm_id)
        return True
    except FlowMessageExistsError:
        logger.info("[bundle] already materialized fm=%s", fm_id)
        return True  # already materialized — counts as success
    except Exception as e:
        logger.error("[bundle] unpack failed fm=%s: %s", fm_id, e, exc_info=True)
        return False
    finally:
        tmp_path.unlink(missing_ok=True)


@action.get(action_name="inbox-list", types=None)
async def inbox_list() -> ApiResponse:
    """Return all non-archived local FlowMessages, newest first."""
    try:
        from flow_sdk.db.drivers.query import QueryFilter
        flt = QueryFilter(type=BuiltinEntityType.FLOW_MESSAGE.value)
        all_messages = await FlowMessage.get_all(flt)
        messages = [m for m in all_messages if not m.is_archived]
        messages.sort(key=lambda m: m.created_date or "", reverse=True)
        return ApiSuccessResponse(data=[m.model_dump(mode="json") for m in messages])
    except Exception as e:
        logger.error("[flow_message_action] inbox-list error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed to list inbox: {str(e)}")


async def handle_inbox_fetch(someone_typeid: str) -> ApiResponse:
    """Pull new FlowMessages from hub, materialize attachments locally."""
    since = _load_last_fetch()
    fetch_started = datetime.now(UTC).isoformat()

    hub_params: dict = {}
    if since:
        hub_params["since"] = since

    logger.warning("[inbox-fetch][DEBUG] since=%r params=%s", since, hub_params)
    result = await hub_get(BuiltinEntityType.FLOW_MESSAGE, params=hub_params)
    logger.warning("[inbox-fetch][DEBUG] hub result type=%s value=%s", type(result).__name__, result)
    if result is None:
        return ApiFailResponse(message="Hub unavailable or not configured")
    # Hub may return a list directly, or {"items": [...], "total": N}, or {"data": [...]}
    if isinstance(result, list):
        raw_messages = result
    elif isinstance(result, dict):
        raw_messages = result.get("items") or result.get("data") or result.get("results") or []
    else:
        raw_messages = []
    logger.warning("[inbox-fetch][DEBUG] raw_messages count=%d ids=%s", len(raw_messages), [m.get("id") for m in raw_messages])

    created_ids: list[str] = []
    for raw in raw_messages:
        fm_id = (raw.get("id") or "").strip()
        if not fm_id:
            continue

        existing = await FlowMessage.get_one({"id": fm_id})
        if existing:
            attachment_filename = (raw.get("attachment_filename") or "").strip()
            if attachment_filename:
                # Always re-unpack bundles when we find an existing FM keyed by the hub FM ID.
                # The hub ID and the bundle's internal FM ID are different — a previous fetch
                # may have saved a stub (hub ID) via the fallback path without updating the
                # conversation. Re-unpacking is fast (FlowMessageExistsError if already done).
                try:
                    if await _download_and_unpack_bundle(fm_id, attachment_filename):
                        created_ids.append(fm_id)
                except Exception as e:
                    logger.warning("[inbox-fetch] re-materialize failed for %s: %s", fm_id, e)
            continue

        # Process attachments — normalise hub TypeId dict format
        # Hub may return attachments as TypeId dicts {'type': '...', 'id': '...'}
        # instead of the Attachment format {'attachment_type': '...', 'data': '...'}.
        attachments: list[Attachment] = []
        for att in (raw.get("attachment") or []):
            if not isinstance(att, dict):
                continue
            if "attachment_type" in att:
                att_type_str = att.get("attachment_type", "")
                att_data = att.get("data", "")
            elif "type" in att and "id" in att:
                # Hub TypeId dict format → normalise to Attachment format
                att_type_str = AttachmentType.TYPE_ID.value
                att_data = f"{att['type']}-{att['id']}"
            else:
                continue
            try:
                att_type = AttachmentType(att_type_str)
            except ValueError:
                continue

            if att_type == AttachmentType.TYPE_ID:
                # Fetch referenced entity from hub (best-effort)
                try:
                    parts = att_data.split("-", 1)
                    if len(parts) == 2:
                        entity_enum = BuiltinEntityType(parts[0])
                        await hub_get(entity_enum, parts[1])
                except Exception:
                    pass
            elif att_type == AttachmentType.FILE:
                # Download file bytes from hub
                try:
                    filename = att_data.split("/")[-1]
                    file_bytes = await hub_get(BuiltinEntityType.FLOW_MESSAGE, fm_id, "fs", f"download/{filename}", raw=True)
                    if file_bytes:
                        dest = FLOW_HOME / "inbox" / fm_id
                        dest.mkdir(parents=True, exist_ok=True)
                        (dest / filename).write_bytes(file_bytes)
                        att_data = str(dest / filename)
                except Exception:
                    pass

            attachments.append(Attachment(attachment_type=att_type, data=att_data))

        # Build context TypeIds
        context: list[TypeId] = []
        for c in (raw.get("context") or []):
            try:
                if isinstance(c, str):
                    context.append(TypeId(c))
                elif isinstance(c, dict):
                    context.append(TypeId(type=c.get("type", ""), id=c.get("id", "")))
            except Exception:
                pass

        # If the sender uploaded a .flowmsg bundle, unpack it — this materializes
        # the Task, Spec, and Conversation locally in one shot.
        attachment_filename = (raw.get("attachment_filename") or "").strip()
        if attachment_filename:
            try:
                bundle_bytes = await hub_get(
                    BuiltinEntityType.FLOW_MESSAGE, fm_id, "fs", f"download/{attachment_filename}", raw=True
                )
                if bundle_bytes:
                    local_user = await User.get_one({"uname": "local"})
                    local_user_id = local_user.id if local_user else ""
                    with tempfile.NamedTemporaryFile(suffix=".flowmsg", delete=False) as tmp:
                        tmp_path = Path(tmp.name)
                        tmp.write(bundle_bytes)
                    try:
                        from flow_sdk.fs_records.flow_message_bundle import unpack_bundle
                        await unpack_bundle(tmp_path, local_user_id, overwrite=False)
                        created_ids.append(fm_id)
                    except FlowMessageExistsError:
                        created_ids.append(fm_id)  # already materialized
                    finally:
                        tmp_path.unlink(missing_ok=True)
                    continue  # entity saved by unpack_bundle — skip the manual save below
            except Exception as e:
                logger.warning("[inbox-fetch] bundle unpack failed for %s (will retry next fetch): %s", fm_id, e)
                continue  # don't save a stub with hub ID — that would block re-unpack next time

        try:
            fm = FlowMessage.model_validate({
                "id": fm_id,
                "text": raw.get("text", ""),
                "instruction": raw.get("instruction"),
                "context": context,
                "attachment": attachments,
                "sender_id": raw.get("sender_id"),
                "sender_name": raw.get("sender_name"),
                "receiver_address": raw.get("receiver_address"),
                "receiver_address_type": raw.get("receiver_address_type"),
                "is_read": False,
                "is_archived": False,
            })
            await fm.save(someone_typeid)
            created_ids.append(fm_id)
        except Exception as e:
            logger.warning("[inbox-fetch] failed to save message %s: %s", fm_id, e)

    _save_last_fetch(fetch_started)
    return ApiSuccessResponse(data={"created": len(created_ids), "ids": created_ids})


@action.get(action_name="inbox-open", types=[BuiltinEntityType.FLOW_MESSAGE.value])
async def inbox_open() -> ApiResponse:
    """Materialize the task referenced by a FlowMessage (downloads bundle if needed).

    Returns {task_id, conversation_id} so the UI can navigate to the task.
    """
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No request info found", status_code=400)

        flow_message_id = str(request_info.target_entity_typeid.id)

        # Prefer local FlowMessage (reply messages are local-only; hub is fallback for inbox messages)
        local_fm = await FlowMessage.get_one({"id": flow_message_id})
        if local_fm:
            attachment_filename = (local_fm.attachment_filename or "").strip()
            raw_context = [str(c) for c in (local_fm.context or [])]
        else:
            hub_data = await hub_get(BuiltinEntityType.FLOW_MESSAGE, flow_message_id)
            attachment_filename = ((hub_data or {}).get("attachment_filename") or "").strip()
            raw_context = (hub_data or {}).get("context") or []

        task_id = None
        conv_id = None
        for c in raw_context:
            type_part, _, id_part = (c if isinstance(c, str) else f"{c.get('type','')}-{c.get('id','')}").partition("-")
            if type_part == BuiltinEntityType.TASK.value:
                task_id = id_part
            elif type_part == BuiltinEntityType.CONVERSATION.value:
                conv_id = id_part

        # If task not local and bundle available, download and unpack
        if task_id and attachment_filename and not await Task.get_one({"id": task_id}):
            await _download_and_unpack_bundle(flow_message_id, attachment_filename)

        return ApiSuccessResponse(data={"task_id": task_id, "conversation_id": conv_id})
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
        fm = await FlowMessage.get_one({"id": fm_id})
        if not fm:
            return ApiFailResponse(message=f"FlowMessage not found: {fm_id}", status_code=404)

        body = await request_info.get_post_data() or {}
        if "is_read" in body:
            fm.is_read = bool(body["is_read"])
        if "is_archived" in body:
            fm.is_archived = bool(body["is_archived"])

        await fm.save(request_info.someone_typeid)
        return ApiSuccessResponse(data={"id": fm_id, "is_read": fm.is_read, "is_archived": fm.is_archived})
    except Exception as e:
        logger.error("[flow_message_action] inbox-update error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Update failed: {str(e)}")


@action.post(action_name="inbox-bulk-update", types=None)
async def inbox_bulk_update() -> ApiResponse:
    """Bulk update is_read / is_archived across all FlowMessages."""
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")

        body = await request_info.get_post_data() or {}
        from flow_sdk.db.drivers.query import QueryFilter
        flt = QueryFilter(type=BuiltinEntityType.FLOW_MESSAGE.value)
        messages = await FlowMessage.get_all(flt)

        count = 0
        for fm in messages:
            changed = False
            if "is_read" in body:
                fm.is_read = bool(body["is_read"])
                changed = True
            if "is_archived" in body:
                fm.is_archived = bool(body["is_archived"])
                changed = True
            if changed:
                await fm.save(request_info.someone_typeid)
                count += 1

        return ApiSuccessResponse(data={"updated": count})
    except Exception as e:
        logger.error("[flow_message_action] inbox-bulk-update error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Bulk update failed: {str(e)}")
