"""HTTP actions for Conversation entities.

  POST /api/v1/graph/conversation/{id}/run-headless

For hub-direct conversations from homelanding (no underlying Task), the same
approve→headless→draft pipeline used by `task_action.run-headless` is wired up
here against the conversation as its own scope. Generic worker plumbing lives
in `headless_run.py`; this module only owns the entity glue (build a
``HeadlessRunScope`` from a ``Conversation``) and the action registration.
"""
from __future__ import annotations

import logging
from typing import Optional

from flow_sdk.actions.action_registry import action
from flow_sdk.app.actions.headless_run import HeadlessRunScope, run_scope
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse

logger = logging.getLogger(__name__)


def _scope_from_conversation(
    conv: Conversation, project_id: Optional[str], workdir: str,
) -> HeadlessRunScope:
    """Build a [conversation, project] scope. No task / spec slots."""
    process_ctx: list[TypeId] = [TypeId(type=BuiltinEntityType.CONVERSATION.value, id=conv.id)]
    if project_id:
        process_ctx.append(TypeId(type=BuiltinEntityType.PROJECT.value, id=project_id))
    return HeadlessRunScope(
        target_typeid=TypeId(type=BuiltinEntityType.CONVERSATION.value, id=conv.id),
        conversation_id=conv.id,
        workdir=workdir,
        project_id=project_id,
        process_context=process_ctx,
        draft_context=[TypeId(type=BuiltinEntityType.CONVERSATION.value, id=conv.id)],
        preferred_process_id=None,  # no shared_process_id stamp on conversations
        log_label="run-headless conv",
    )


async def handle_run_headless_on_conversation(
    conv_id: str, prompt_text: str, someone_typeid: str,
) -> ApiResponse:
    """Run `prompt_text` headlessly scoped to a Conversation; result becomes a draft reply.

    The conversation must be mapped to a local project first
    (``Conversation.project_id`` resolves to a real ``Project`` with a
    ``fs_storage_mount_path``).
    """
    conv = await Conversation.get_one({"id": conv_id})
    if not conv:
        return ApiFailResponse(message=f"Conversation not found: {conv_id}")

    workdir: str = ""
    project_id: Optional[str] = conv.project_id
    if project_id:
        from flow_sdk.builtin.project import Project
        project = await Project.get_one({"id": project_id})
        workdir = (project.fs_storage_mount_path or "").strip() if project else ""

    scope = _scope_from_conversation(conv, project_id, workdir)
    return await run_scope(scope, prompt_text, someone_typeid)


@action.post(action_name="run-headless", types=["conversation"])
async def run_headless_on_conversation() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No request info found")
        if not request_info.someone_typeid:
            return ApiFailResponse(message="No authenticated user in request context")
        body = await request_info.get_post_data() or {}
        prompt_text = (body.get("prompt") or "").strip()
        return await handle_run_headless_on_conversation(
            conv_id=str(request_info.target_entity_typeid.id),
            prompt_text=prompt_text,
            someone_typeid=request_info.someone_typeid,
        )
    except Exception as e:
        logger.error("[conversation_action] run-headless error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed to run headless on conversation: {str(e)}")
