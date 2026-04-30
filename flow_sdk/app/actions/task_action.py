"""HTTP actions for Task entities.

  POST /api/v1/graph/task/{id}/run-headless

The run-headless action drives an invisible AgenticProcess scoped to a task
and stages its assistant output as a *draft* FlowMessage on the task's
conversation. Used by the conversation `useApproveAndExecuteHeadless` hook
(plan: Scenarios A/B/C) so approving a PROMPT runs without opening a PTY tab.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Optional

from flow_sdk.actions.action_registry import action
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.cli_drivers import AgenticContext
from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli import ClaudeCliOptions
from flow_sdk.builtin.agentic_process.cli_drivers.claude.stream_worker import (
    ClaudeCLIStreamWorker,
)
from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
from flow_sdk.builtin.task import Task
from flow_sdk.builtin.user import User
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowElementType
from flow_sdk.fs_records.agentic_process_lifecycle import ProcessStatus
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)


_ALIVE_PROCESS_STATUSES: frozenset[str] = frozenset({
    ProcessStatus.NEW.value,
    ProcessStatus.STARTING.value,
    ProcessStatus.RUNNING.value,
})


async def _resolve_or_spawn_process(task: Task, someone_typeid: str, workdir: str) -> AgenticProcess:
    """Reuse `task.shared_process_id` when alive, otherwise spawn a fresh headless process."""
    if task.shared_process_id:
        existing = await AgenticProcess.get_one({"id": task.shared_process_id})
        if existing and existing.status in _ALIVE_PROCESS_STATUSES:
            return existing

    project_id: Optional[str] = task.project_id
    if not project_id:
        from flow_sdk.builtin.project import Project
        project = await Project.recover_by_path(workdir)
        if project:
            project_id = project.id

    cli_opts = ClaudeCliOptions(
        print_mode=True,
        output_format="stream-json",
        verbose=True,
        permission_mode="bypassPermissions",
    )
    process = AgenticProcess(
        cli_config=cli_opts.to_json(),
        workdir=workdir,
        visible=False,
        project_id=project_id or None,
        target_vfs_path=str(TypeId(type=BuiltinEntityType.TASK.value, id=task.id)),
    )
    await process.save(someone_typeid)
    return process


def _extract_assistant_text(flow_data_items: list) -> str:
    """Concatenate assistant CHAT text from a captured FlowData stream.

    Skips TOOL_CALL / TOOL_RESULT / STATUS / REASONING entries — they are
    transient turn-internal mechanics; only the assistant's user-facing text
    becomes the draft message body.
    """
    parts: list[str] = []
    for fd in flow_data_items:
        attrs = getattr(fd, "attributes", None) or {}
        if attrs.get("element-type") != FlowElementType.CHAT:
            continue
        if attrs.get("role") != "assistant":
            continue
        value = getattr(fd, "flow_value", None)
        if isinstance(value, str) and value:
            parts.append(value)
    if parts:
        return "\n\n".join(parts).strip()

    # Fallback: surface the RESULT event's `result` field when no CHAT text
    # was emitted (rare — typical when the turn finished entirely via tool calls).
    for fd in flow_data_items:
        attrs = getattr(fd, "attributes", None) or {}
        if attrs.get("element-type") != FlowElementType.RESULT:
            continue
        value = getattr(fd, "flow_value", None)
        if isinstance(value, dict):
            result_text = value.get("result")
            if isinstance(result_text, str) and result_text:
                return result_text.strip()
    return ""


async def _save_draft_flow_message(
    *,
    task: Task,
    text: str,
    sender_id: Optional[str],
    sender_name: str,
    someone_typeid: str,
) -> Optional[FlowMessage]:
    """Persist the captured run output as a draft FlowMessage on `task.conversation_id`."""
    if not text or not task.conversation_id:
        return None
    fm = FlowMessage.model_validate({
        "text": text,
        "context": [
            TypeId(type=BuiltinEntityType.TASK.value, id=task.id),
            TypeId(type=BuiltinEntityType.CONVERSATION.value, id=task.conversation_id),
        ],
        "attachment": [],
        "sender_id": sender_id,
        "sender_name": sender_name,
        "conversation_id": task.conversation_id,
        "is_draft": True,
    })
    fm.id = FlowMessage.allocate_id(fm.model_dump())
    fm.attachment = [
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.TASK.value, id=task.id))),
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.CONVERSATION.value, id=task.conversation_id))),
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.FLOW_MESSAGE.value, id=fm.id))),
    ]
    return await fm.save(someone_typeid)


async def _run_turn_and_capture(
    *,
    process: AgenticProcess,
    prompt_text: str,
    task: Task,
    sender_id: Optional[str],
    sender_name: str,
    someone_typeid: str,
) -> None:
    """Drive ClaudeCLIStreamWorker headlessly, capturing assistant text into a draft FlowMessage."""
    from flow_sdk.builtin.agentic_process.agentic_process import _PROMPT_WORKERS

    cli_cfg = process.cli_config or {}
    is_resume = bool(cli_cfg.get("resume")) or bool(process.session_id)
    context = AgenticContext(
        workdir=process.workdir,
        env_vars=dict(cli_cfg.get("env_vars") or {}),
        model=cli_cfg.get("model") or "sonnet",
        permission_mode=cli_cfg.get("permission_mode", "bypassPermissions"),
        resume_session_id=process.session_id if is_resume else None,
        session_id=None if is_resume else process.session_id,
    )

    if process.status != ProcessStatus.RUNNING.value:
        process.status = ProcessStatus.RUNNING.value
        try:
            await process.save(someone_typeid)
        except Exception:
            logger.debug("[run-headless] lifecycle save failed", exc_info=True)

    worker = ClaudeCLIStreamWorker()
    _PROMPT_WORKERS[process.id] = worker
    captured: list = []
    try:
        async for fd in worker.execute(prompt=prompt_text, context=context):
            captured.append(fd)
            sid = worker.get_session_id()
            if sid and process.session_id != sid:
                process.session_id = sid
                try:
                    await process.save(someone_typeid)
                except Exception:
                    logger.debug("[run-headless] session_id save failed", exc_info=True)
            try:
                await process.emit_flow_data(fd.model_dump())
            except Exception:
                logger.debug("[run-headless] emit_flow_data failed", exc_info=True)
    except Exception:
        logger.exception("[run-headless] worker error")
        return
    finally:
        _PROMPT_WORKERS.pop(process.id, None)
        try:
            await process.notify_updated()
        except Exception:
            logger.debug("[run-headless] terminal notify_updated failed", exc_info=True)

    text = _extract_assistant_text(captured)
    if not text:
        logger.warning("[run-headless] empty assistant output for task=%s process=%s", task.id, process.id)
        return
    await _save_draft_flow_message(
        task=task,
        text=text,
        sender_id=sender_id,
        sender_name=sender_name,
        someone_typeid=someone_typeid,
    )


async def handle_run_headless(task_id: str, prompt_text: str, someone_typeid: str) -> ApiResponse:
    """Run `prompt_text` headlessly on a task-bound AgenticProcess; result becomes a draft reply.

    Returns the process_id immediately — the run is fired in the background and
    surfaces in the UI via the standard process entity-update channels (Runs
    drawer) and via the draft FlowMessage entity query (ConversationView).
    """
    if not prompt_text:
        return ApiFailResponse(message="prompt is required")
    task = await Task.get_one({"id": task_id})
    if not task:
        return ApiFailResponse(message=f"Task not found: {task_id}")

    workdir = (task.project_root or "").strip()
    if not workdir:
        return ApiFailResponse(
            message="task has no project_root — map it to a local project first"
        )

    local_user = await User.get_one({"uname": "local"})
    sender_id: Optional[str] = local_user.id if local_user else None
    sender_name: str = (local_user.name or local_user.email or "") if local_user else ""

    process = await _resolve_or_spawn_process(task, someone_typeid, workdir)

    asyncio.create_task(
        _run_turn_and_capture(
            process=process,
            prompt_text=prompt_text,
            task=task,
            sender_id=sender_id,
            sender_name=sender_name,
            someone_typeid=someone_typeid,
        ),
        name=f"run-headless-{task.id[:8]}",
    )

    return ApiSuccessResponse(data={"process_id": process.id})


@action.post(action_name="run-headless", types=["task"])
async def run_headless() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No request info found")
        if not request_info.someone_typeid:
            return ApiFailResponse(message="No authenticated user in request context")

        body = await request_info.get_post_data() or {}
        prompt_text = (body.get("prompt") or "").strip()
        return await handle_run_headless(
            task_id=str(request_info.target_entity_typeid.id),
            prompt_text=prompt_text,
            someone_typeid=request_info.someone_typeid,
        )
    except Exception as e:
        logger.error("[task_action] run-headless error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed to run headless: {str(e)}")
