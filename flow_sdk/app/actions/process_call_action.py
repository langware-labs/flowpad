"""A call on a message, answered by its receiver (``process_call_spec``).

``POST /graph/conversation/<id>/process-call`` — body ``{message_id, decision}``:

- ``approve``: run the call once, here, then reply with its ``ReturnedValue``.
- ``decline``: reply with a refusal; nothing runs.
- ``stop``: cancel a run in flight; the reply says it was stopped.

``POST /graph/conversation/<id>/process-call-status`` — ``{running: [call_id, …]}``.

Nothing runs on arrival: the receiver always approves, every call. No Prompt or
PromptCompletion row is written — the call's text lives only on the message.
"""

from __future__ import annotations

import asyncio
import logging
from json import JSONDecodeError
from pathlib import Path
from typing import Optional

from flow_sdk.actions import action
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.schema.data_spec.process_call_spec import (
    RETURNED_VALUE_TYPE,
    ProcessCall,
    answer_attachment,
    process_call_in,
)
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, ReturnedValue

logger = logging.getLogger(__name__)

#: Runs in flight on this machine: call id -> (conversation id, task). A run outlives its request.
_RUNNING: dict[str, tuple[str, asyncio.Task]] = {}
STOPPED = "Stopped by the receiver before it finished."


async def _workdir(conv) -> Path:
    """The conversation's project folder, else the instance's scratch folder (never a new Project)."""
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.builtin.remote_worker_session import scratch_workdir  # noqa: PLC0415

    project_id = getattr(conv, "project_id", None)
    if project_id:
        project = await Project.get_one({"id": project_id})
        folder = getattr(project, "fs_storage_mount_path", None) if project else None
        if folder:
            return Path(folder)
    return scratch_workdir()


async def _answered(conversation_id: str, call_id: str) -> bool:
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415

    marker = f"{RETURNED_VALUE_TYPE}-{call_id}"
    for fm in await FlowMessage.get_all({"conversation_id": conversation_id}):
        if any((a.data or "") == marker for a in (fm.attachment or [])):
            return True
    return False


async def _answer(conversation_id: str, call: ProcessCall, answer: ReturnedValue, someone_typeid: str):
    from flow_sdk.app.actions.notification_action import handle_add_message  # noqa: PLC0415

    return await handle_add_message(
        {
            "conversation_id": conversation_id,
            "message": "",
            # No ``reply_to_id``: a quote would open a thread under the call. The call id pairs them.
            "attachment": [answer_attachment(call, answer)],
        },
        someone_typeid,
    )


async def _run(conversation_id: str, call: ProcessCall, someone_typeid: str) -> None:
    from flow_sdk.builtin.conversation import Conversation  # noqa: PLC0415
    from flow_sdk.core.compute.process_call import run_process_call  # noqa: PLC0415

    try:
        try:
            workdir = await _workdir(await Conversation.get_one({"id": conversation_id}))
            answer = await run_process_call(call, workdir=workdir)
        except asyncio.CancelledError:
            answer = ReturnedValue(exit_code=ExitCode.NOT_YET, detail=STOPPED)
        except Exception as exc:  # noqa: BLE001 — an answer, never a silent death
            logger.exception("process call %s crashed", call.call_id)
            answer = ReturnedValue(exit_code=ExitCode.NOT_YET, detail=f"The run failed: {exc}")
        await _answer(conversation_id, call, answer, someone_typeid)
    finally:
        _RUNNING.pop(call.call_id, None)


async def decide_process_call(conversation_id: str, body: dict, someone_typeid: str) -> ApiResponse:
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415
    from flow_sdk.server.routes.bootstrap import get_or_create_local_user  # noqa: PLC0415

    decision = str(body.get("decision") or "")
    if decision not in ("approve", "decline", "stop"):
        return ApiFailResponse(message="decision must be 'approve', 'decline' or 'stop'", status_code=400)
    fm_id = str(body.get("message_id") or "")
    fm = await FlowMessage.get_one({"id": fm_id}) if fm_id else None
    if fm is None or fm.conversation_id != conversation_id:
        return ApiFailResponse(message="no such message in this conversation", status_code=404)
    call = process_call_in(fm.attachment)
    if call is None:
        return ApiFailResponse(message="this message carries no call", status_code=400)

    if decision == "stop":
        running = _RUNNING.get(call.call_id)
        if running is None:
            return ApiFailResponse(message="this call is not running", status_code=409)
        running[1].cancel()
        return ApiSuccessResponse(data={"call_id": call.call_id, "status": "stopping"})

    local_user = await get_or_create_local_user()
    if fm.sender_id and local_user and fm.sender_id == local_user.id:
        return ApiFailResponse(message="you sent this call — its receiver decides", status_code=403)
    if call.call_id in _RUNNING:
        return ApiFailResponse(message="this call is already running", status_code=409)
    if await _answered(conversation_id, call.call_id):
        return ApiFailResponse(message="this call was already answered", status_code=409)

    if decision == "decline":
        from flow_sdk.core.compute.process_call import declined  # noqa: PLC0415

        await _answer(conversation_id, call, declined(), someone_typeid)
        return ApiSuccessResponse(data={"call_id": call.call_id, "status": "declined"})

    _RUNNING[call.call_id] = (conversation_id, asyncio.create_task(_run(conversation_id, call, someone_typeid)))
    return ApiSuccessResponse(data={"call_id": call.call_id, "status": "running"})


def _conversation_request() -> "tuple[Optional[str], Optional[str], Optional[ApiResponse]]":
    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        return None, None, ApiFailResponse(message="target conversation required", status_code=400)
    if request_info.target_entity_typeid.type != "conversation":
        return None, None, ApiFailResponse(message="target must be a conversation", status_code=400)
    if not request_info.someone_typeid:
        return None, None, ApiFailResponse(message="No authenticated user in request context")
    return request_info.target_entity_typeid.id, request_info.someone_typeid, None


@action.post(action_name="process-call", types=["conversation"])
async def conversation_process_call() -> ApiResponse:
    conversation_id, someone_typeid, refused = _conversation_request()
    if refused is not None:
        return refused
    try:
        body = await get_current_request_info().get_post_data() or {}
    except JSONDecodeError:
        body = {}
    return await decide_process_call(conversation_id, body, someone_typeid)


@action.post(action_name="process-call-status", types=["conversation"])
async def conversation_process_call_status() -> ApiResponse:
    """The calls running on this machine — a card that reloads mid-run still says ``working…``."""
    conversation_id, _, refused = _conversation_request()
    if refused is not None:
        return refused
    return ApiSuccessResponse(data={"running": sorted(c for c, (conv, _) in _RUNNING.items() if conv == conversation_id)})
