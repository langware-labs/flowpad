"""HTTP actions for Task entities.

  POST /api/v1/graph/task/{id}/run-headless

The run-headless action drives an invisible AgenticProcess scoped to a task
and stages its assistant output as a draft FlowMessage on the task's
conversation. Used by the conversation `useApproveAndExecuteHeadless` hook
(plan: Scenarios A/B/C) so approving a PROMPT runs without opening a PTY tab.

Generic worker plumbing lives in ``headless_run.py``; this module only owns
the entity glue (build a ``HeadlessRunScope`` from a ``Task``) and the action
registration. The conversation-scoped twin lives in ``conversation_action.py``.
"""
from __future__ import annotations

import logging
from typing import Optional

from flow_sdk.actions.action_registry import action
from flow_sdk.app.actions.headless_run import HeadlessRunScope, run_scope
from flow_sdk.builtin.task import Task
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse

logger = logging.getLogger(__name__)


def _scope_from_task(
    task: Task,
    project_id: Optional[str],
    source_flow_message_id: Optional[str] = None,
) -> HeadlessRunScope:
    """Build a [task, conversation, spec, project] scope.

    Skips slots the task hasn't filled yet (e.g. no spec on a "request" task,
    no project until mapping). Project comes last so it stays appendable when
    project mapping happens after spawn. The draft context drops project
    (FlowMessage attachments don't reference projects today).
    """
    conv_typeid = task.first_context_of_type(BuiltinEntityType.CONVERSATION.value)
    spec_typeid = task.first_context_of_type(BuiltinEntityType.SPEC.value)

    process_ctx: list[TypeId] = [TypeId(type=BuiltinEntityType.TASK.value, id=task.id)]
    if conv_typeid:
        process_ctx.append(conv_typeid)
    if spec_typeid:
        process_ctx.append(spec_typeid)
    if project_id:
        process_ctx.append(TypeId(type=BuiltinEntityType.PROJECT.value, id=project_id))

    draft_ctx: list[TypeId] = [TypeId(type=BuiltinEntityType.TASK.value, id=task.id)]
    if conv_typeid:
        draft_ctx.append(conv_typeid)

    return HeadlessRunScope(
        target_typeid=TypeId(type=BuiltinEntityType.TASK.value, id=task.id),
        conversation_id=conv_typeid.id if conv_typeid else "",
        workdir=(task.project_root or "").strip(),
        project_id=project_id,
        process_context=process_ctx,
        draft_context=draft_ctx,
        preferred_process_id=task.shared_process_id,
        source_flow_message_id=source_flow_message_id,
        log_label="run-headless",
    )


async def handle_run_headless(
    task_id: str,
    prompt_text: str,
    someone_typeid: str,
    source_flow_message_id: Optional[str] = None,
) -> ApiResponse:
    """Run `prompt_text` headlessly on a task-bound AgenticProcess; result becomes a draft reply."""
    task = await Task.get_one({"id": task_id})
    if not task:
        return ApiFailResponse(message=f"Task not found: {task_id}")

    workdir = (task.project_root or "").strip()
    project_id: Optional[str] = task.project_id
    if not project_id and workdir:
        from flow_sdk.builtin.project import Project
        project = await Project.recover_by_path(workdir)
        if project:
            project_id = project.id

    scope = _scope_from_task(task, project_id, source_flow_message_id)
    return await run_scope(scope, prompt_text, someone_typeid)


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
        source_fm_id = (body.get("source_flow_message_id") or "").strip() or None
        return await handle_run_headless(
            task_id=str(request_info.target_entity_typeid.id),
            prompt_text=prompt_text,
            someone_typeid=request_info.someone_typeid,
            source_flow_message_id=source_fm_id,
        )
    except Exception as e:
        logger.error("[task_action] run-headless error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed to run headless: {str(e)}")
