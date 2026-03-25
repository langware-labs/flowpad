"""Listen action for receiving webhook events and dispatching to handlers.

Ported from FlowPad: flowpad/hub/app/actions/listen.py
Simplified for desktop mode:
- No cross-service routing (single local machine)
- Sniffer broadcast uses local connections only
- 2 webhook types: agent_hook, hook_op
- hook_op v2 envelope: unified CRUD+event+invoke+log dispatch

NOTE: This is a DEDICATED route handler called directly from webhook_router
(server/routes/webhook.py), NOT a graph action.  The old FlowPad uses the
same pattern: the listen function lives in flowpad/hub/app/actions/listen.py
but is invoked by the webhook router, not by the graph catch-all.  Do NOT add
an @action.all decorator here -- the graph route's handle_request() reads the
request body before dispatching, which makes a second request.json() call hang
(the ASGI receive channel is one-shot).
"""

import logging
from datetime import datetime, timezone
from typing import Optional, Tuple

from pydantic import ValidationError
from starlette.requests import ClientDisconnect

from flow_sdk.builtin.agent_hook import HookEventType
from flow_sdk.core.flow.models.hook_op import (
    HookOpPayload,
    RelationshipType,
    SyncOperation,
)
from flow_sdk.core.flow.models.webhook_flow_data import (
    AgentHookData,
    SkillNotification,
    WebhookPayload,
    WebhookType,
)
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)

# Track last Write / Edit file_path per session for plan file resolution.
# When PreToolUse:ExitPlanMode arrives, the most recent PostToolUse:Write
# for that session usually points to the plan .md file.
_last_file_op_path_by_session: dict[str, str] = {}

# Track execute-plan approval flag per agentic_process ID.
# Flag is set by execute-plan, consumed (cleared) by PermissionRequest:ExitPlanMode
# or UserPromptSubmit (new user input cancels auto-approve).
# Keyed by agentic_process ID (not session ID) because /clear creates a new session.
_plan_auto_approve_by_agentic_process: set[str] = set()


# ---------------------------------------------------------------------------
# Helper: broadcast to the @sniffer AgentHook for the frontend sniffer panel
# ---------------------------------------------------------------------------


async def _route_to_source_process(
    payload_data: dict,
    execution_scope: list | None = None,
    session_id: str | None = None,
) -> None:
    """Route webhook event to the AgenticProcess that generated it.

    Uses execution_scope (from hook_op) or session_id (from agent_hook)
    to find the source process and emit a flow_data_msg to its watchers.
    """
    try:
        from flow_sdk.builtin.agentic_processor import _send_flow_data_message
    except Exception:
        return

    now_iso = datetime.now(timezone.utc).isoformat()
    flow_msg = {
        "element_type": "webhook",
        "data_type": "object",
        "flow_value": payload_data,
        "attributes": {"t": now_iso},
    }

    # Route via execution_scope (hook_op events)
    if execution_scope:
        for entry in execution_scope:
            target_type = entry.get("type") if isinstance(entry, dict) else None
            target_id = entry.get("id") if isinstance(entry, dict) else None
            if target_type and target_id:
                await _send_flow_data_message(target_type, target_id, flow_msg)
        return

    # Helper: find first process matching a field and route the message
    async def _find_and_route(field_name: str, field_value: str) -> bool:
        try:
            from flow_sdk.builtin.agentic_processor import AgenticProcess
            from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter

            processes = await AgenticProcess.get_all(entities_filter=QueryFilter(match=ExpressionNode(**{field_name: field_value})))
            for proc in processes or []:
                await _send_flow_data_message(proc.get_type(), proc.id, flow_msg)
                return True
        except Exception as exc:
            logger.debug("Failed to route to process by %s: %s", field_name, exc)
        return False

    # Route via session_id (agent_hook events — match worker_session_id)
    if session_id:
        if await _find_and_route("worker_session_id", session_id):
            return

    # Fallback: route via pty_pid from payload
    pty_pid = payload_data.get("pty_pid") if isinstance(payload_data, dict) else None
    if pty_pid:
        await _find_and_route("pty_pid", pty_pid)


async def _broadcast_to_sniffer(
    payload_data: dict,
    webhook_type: str,
    skip_hook_id: str | None = None,
    warning: str | None = None,
    element_type: str | None = None,
    data_type: str | None = None,
) -> None:
    """Emit the webhook event to the @sniffer AgentHook so the frontend sniffer can display it.

    Args:
        payload_data: Payload dict from the incoming webhook data.
        webhook_type: The webhook_type string.
        skip_hook_id: If the current webhook already targets this AgentHook id, skip to avoid duplicates.
        warning: Optional warning message to include in the emitted FlowData attributes.
        element_type: Optional element type override.
        data_type: Optional data type override.
    """
    try:
        from flow_sdk.builtin.agent_hook import AgentHook
    except ImportError:
        logger.debug("AgentHook not available, skipping sniffer broadcast")
        return

    sniffer_hook = await AgentHook.get_by_uname("sniffer")
    if sniffer_hook is None:
        # Fallback: find by name for hooks created before uname was added
        try:
            from flow_sdk.app.actions.hooks_sniffer import _get_sniffer_hook

            sniffer_hook = await _get_sniffer_hook()
        except ImportError:
            pass
    if sniffer_hook is None:
        return

    # Don't double-emit when the webhook already targets this exact hook
    if skip_hook_id and sniffer_hook.id == skip_hook_id:
        return

    attrs = {
        "element-type": element_type or "webhook",
        "data-type": data_type or "object",
        "webhook_type": webhook_type,
        "t": datetime.now(timezone.utc).isoformat(),
    }
    if warning:
        attrs["warning"] = warning

    try:
        await sniffer_hook.emit_flow_data(
            {
                "flow_value": payload_data,
                "attributes": attrs,
            }
        )
    except Exception as e:
        logger.debug(f"Sniffer broadcast failed (non-critical): {e}")


# ---------------------------------------------------------------------------
# Per-type handlers (simplified for desktop -- no Flow entity, no WS routing)
# ---------------------------------------------------------------------------


async def _create_prompt_annotation(content: str, session_id: str) -> None:
    """Create an Annotation entity for a UserPromptSubmit event. Non-critical."""
    try:
        from flow_sdk.builtin.agentic_processor import AgenticProcess
        from flow_sdk.builtin.annotation import Annotation
        from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter

        now_iso = datetime.now(timezone.utc).isoformat()
        processes = await AgenticProcess.get_all(entities_filter=QueryFilter(match=ExpressionNode(worker_session_id=session_id)))
        process_id = ""
        if processes:
            process_id = processes[0].id or ""

        annotation = Annotation(
            labels=["prompt:"],
            target_type="agentic_process",
            target_id=process_id,
            content=content[:50],
            session_id=session_id,
            iso_timestamp=now_iso,
            data={},
        )
        await annotation.save([])
    except Exception as exc:
        logger.debug("_create_prompt_annotation failed (non-critical): %s", exc)


def _track_file_op_path(hook_data_dict: dict) -> None:
    """On PostToolUse:Write or PostToolUse:Edit, cache tool_input.file_path keyed by session_id."""
    session_id = hook_data_dict.get("session_id", "")
    tool_input = hook_data_dict.get("tool_input", {})
    file_path = tool_input.get("file_path", "")
    if session_id and file_path:
        _last_file_op_path_by_session[session_id] = file_path


def _extract_agentic_process_id(execution_scope: list) -> str | None:
    """Return the first agentic_process ID from execution_scope.

    Accepts both dict entries {"type": "agentic_process", "id": "..."} and
    TypeId strings (e.g. "agentic_process:uuid").
    """
    from flow_sdk.builtin.agentic_processor import AgenticProcess
    for entry in execution_scope:
        if isinstance(entry, dict) and entry.get("type") == AgenticProcess.get_type() and entry.get("id"):
            return entry["id"]
        elif TypeId.is_typeid(entry):
            tid = TypeId.to_typeid(entry)
            if tid.type == AgenticProcess.get_type():
                return tid.id
    return None


async def _close_worktree_process(agentic_process_id: str) -> None:
    """Close the tab for a worktree agentic process after ExitWorktree completes.

    Mirrors the frontend closeShell sequence: exit the process first (which
    detaches shell_id), then close the shell so it disappears from the tab list.
    """
    try:
        from flow_sdk.builtin.agentic_processor import AgenticProcess
        from flow_sdk.builtin.shell import Shell

        process = await AgenticProcess.get_by_id(agentic_process_id)
        if not process:
            logger.debug("[ExitWorktree] Process %s not found", agentic_process_id)
            return

        # Snapshot shell_id before exit_action() clears it
        shell_id = process.shell_id

        result = await process.exit_action()
        if not isinstance(result, ApiSuccessResponse):
            logger.debug("[ExitWorktree] Process %s exit skipped: %s", agentic_process_id, result.message)
            return
        logger.info("[ExitWorktree] Terminated process %s", agentic_process_id)

        if shell_id:
            shell = await Shell.get_by_id(shell_id)
            if shell:
                await shell.close()
                logger.info("[ExitWorktree] Closed shell %s for process %s", shell_id, agentic_process_id)
    except Exception as exc:
        logger.warning("[ExitWorktree] Failed to close process %s: %s", agentic_process_id, exc)


def set_plan_auto_approve(agentic_process_id: str | None) -> None:
    """Set the auto-approve flag for an agentic_process (called by execute-plan)."""
    if agentic_process_id:
        _plan_auto_approve_by_agentic_process.add(agentic_process_id)
        logger.info("[auto-approve] FLAG SET for agentic_process %s", agentic_process_id)


async def _create_plan_annotation(tool_input: dict, session_id: str) -> None:
    """Create an Annotation entity for an ExitPlanMode event. Non-critical."""
    try:
        from flow_sdk.builtin.agentic_processor import AgenticProcess
        from flow_sdk.builtin.annotation import Annotation
        from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter

        plan_text = tool_input.get("plan", "")

        # Resolve plan file from last Write / Edit path if it's a .claude/plans/*.md
        plan_file_path = ""
        last_file_op = _last_file_op_path_by_session.pop(session_id, None)
        last_file_op_str = str(last_file_op) if last_file_op else ""
        if last_file_op_str and ".claude/plans/" in last_file_op_str and last_file_op_str.endswith(".md"):
            plan_file_path = last_file_op_str

        now_iso = datetime.now(timezone.utc).isoformat()
        agentic_processes = await AgenticProcess.get_all(
            entities_filter=QueryFilter(match=ExpressionNode(worker_session_id=session_id))
        )
        agentic_process_id = agentic_processes[0].id if agentic_processes else ""

        content = plan_text[:50] if plan_text else "Plan created"

        annotation = Annotation(
            labels=["plan:"],
            target_type=AgenticProcess.get_type(),
            target_id=agentic_process_id,
            content=content,
            session_id=session_id,
            iso_timestamp=now_iso,
            data={"file_path": plan_file_path},
        )
        await annotation.save([])
    except Exception as exc:
        logger.debug("_create_plan_annotation failed (non-critical): %s", exc)


async def handle_agent_hook(webhook_data: AgentHookData) -> ApiSuccessResponse | ApiFailResponse:
    """Handle agent_hook webhook - process triggers connected to the AgentHook."""
    agent_hook_id = webhook_data.agent_hook_id
    if not agent_hook_id:
        return ApiFailResponse(message="agent_hook_id is required in payload")

    # Resolve hook fields first — needed for annotations and auto-approve logic,
    # independent of whether the AgentHook entity exists in the DB.
    hook_data_dict = webhook_data.hook_data if isinstance(webhook_data.hook_data, dict) else {}
    raw = hook_data_dict.get("raw_hook_data", {}) if isinstance(hook_data_dict.get("raw_hook_data"), dict) else {}

    hook_event_name = hook_data_dict.get("hook_event_name") or raw.get("hook_event_name", "")
    hook_session_id = hook_data_dict.get("session_id") or raw.get("session_id", "")
    hook_tool_name = hook_data_dict.get("tool_name") or raw.get("tool_name", "")
    hook_tool_input = hook_data_dict.get("tool_input") or raw.get("tool_input", {})
    execution_scope = hook_data_dict.get("execution_scope") or raw.get("execution_scope") or []
    cwd = raw.get("cwd")
    agentic_process_id = _extract_agentic_process_id(execution_scope)

    if hook_event_name == HookEventType.CWD_CHANGED:
        logger.info(f"[cwd change] to '{cwd}' (session={hook_session_id})")

    # Track last Write/Edit path per session; any other event resets it.
    if hook_event_name == HookEventType.POST_TOOL_USE and hook_tool_name in ("Write", "Edit"):
        _track_file_op_path({"session_id": hook_session_id, "tool_input": hook_tool_input})

    # Auto-close the worktree tab when ExitWorktree completes
    if hook_event_name == HookEventType.POST_TOOL_USE and hook_tool_name == "ExitWorktree" and agentic_process_id:
        await _close_worktree_process(agentic_process_id)

    # Auto-approve ExitPlanMode PermissionRequest if flag is set, then clear flag.
    # `flow hooks report --wait-for-response` makes this synchronous.
    if hook_event_name == HookEventType.PERMISSION_REQUEST and hook_tool_name == "ExitPlanMode" and agentic_process_id and agentic_process_id in _plan_auto_approve_by_agentic_process:
        _plan_auto_approve_by_agentic_process.discard(agentic_process_id)
        logger.info(f"[auto-approve] APPROVED ExitPlanMode for agentic_process {agentic_process_id} (session={hook_session_id})")
        return ApiSuccessResponse(
            data={
                "hookSpecificOutput": {
                    "hookEventName": hook_event_name,
                    "decision": {"behavior": "allow"},
                },
            }
        )

    # Clear auto-approve flag on UserPromptSubmit
    if hook_event_name == HookEventType.USER_PROMPT_SUBMIT  and agentic_process_id in _plan_auto_approve_by_agentic_process:
        _plan_auto_approve_by_agentic_process.discard(agentic_process_id)
        logger.info("[auto-approve] Cleared stale flag for entity %s on UserPromptSubmit", agentic_process_id)

    # Auto-create Annotation for UserPromptSubmit
    if hook_event_name == HookEventType.USER_PROMPT_SUBMIT:
        prompt = str(hook_data_dict.get("prompt") or raw.get("prompt", ""))
        if prompt and hook_session_id:
            await _create_prompt_annotation(prompt[:50], hook_session_id)

    # Auto-create Annotation for PreToolUse:ExitPlanMode (consume cached Write path)
    if hook_event_name == HookEventType.PRE_TOOL_USE and hook_tool_name == "ExitPlanMode":
        if hook_session_id:
            await _create_plan_annotation(hook_tool_input or {}, hook_session_id)

    try:
        from flow_sdk.builtin.agent_hook import AgentHook
    except ImportError:
        return ApiFailResponse(message="AgentHook entity not available")

    # Load the AgentHook entity
    agent_hook = await AgentHook.get_by_id(agent_hook_id)
    if agent_hook is None:
        # Hook entity not found (stale hook registration) — annotations already created above
        logger.debug("AgentHook not found: %s — skipping entity-specific handling", agent_hook_id)
        return ApiSuccessResponse(data={})

    # Use the refactored handle_webhook method
    result = await agent_hook.handle_webhook(webhook_data)

    # Emit FlowData for live sniffer/watchers
    payload_data = {
        "webhook_type": "agent_hook",
        "agent_hook_id": agent_hook_id,
        "hook_data": webhook_data.hook_data,
        "hook_entry_id": webhook_data.hook_entry_id,
        "hook_metadata": webhook_data.hook_metadata,
        "hook_file_path": webhook_data.hook_file_path,
    }

    try:
        await agent_hook.emit_flow_data(
            {
                "flow_value": payload_data,
                "attributes": {
                    "element-type": "webhook",
                    "data-type": "object",
                    "webhook_type": "agent_hook",
                    "hook_event_name": hook_event_name or "",
                    "agent_hook_id": agent_hook_id,
                    "t": datetime.now(timezone.utc).isoformat(),
                },
            }
        )
    except Exception as e:
        logger.debug(f"AgentHook emit_flow_data failed (non-critical): {e}")

    return ApiSuccessResponse(data=result.model_dump())


# ---------------------------------------------------------------------------
# hook_op: generic entity CRUD + event + invoke + log dispatch
# ---------------------------------------------------------------------------

# System fields that should never be overwritten by external sync payloads.
_ENTITY_SYSTEM_FIELDS = frozenset(
    {
        "id",
        "type",
        "created_by",
        "created_date",
        "updated_by",
        "updated_date",
        "created_through",
        "updated_through",
        "schema_version",
        "namespace",
        "key",
        "uname",
        "expand",
    }
)


def _apply_entity_fields(entity, payload: dict) -> None:
    """Apply payload fields to an existing entity, skipping system fields."""
    valid_fields = set(entity.__class__.model_fields.keys()) - _ENTITY_SYSTEM_FIELDS
    for field_name in valid_fields:
        if field_name in payload:
            setattr(entity, field_name, payload[field_name])




async def _handle_relationship_sync(
    sync_payload: HookOpPayload,
) -> ApiSuccessResponse | ApiFailResponse:
    """Handle relationship CRUD operations (parent-child, etc.).

    Relationship payload structure::

        {
            "type": "child",  # relationship type
            "id": "child:task:task-1:agentic_process:proc-1",
            "operation": "create",
            "data": {
                "from_ref": {"id": "task-1", "type": "task"},
                "to_ref": {"id": "proc-1", "type": "agentic_process"}
            }
        }
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    relationship_type = sync_payload.type
    operation = sync_payload.operation
    data = sync_payload.data

    logger.info(f"[RELATIONSHIP_SYNC] type={relationship_type} op={operation} id={sync_payload.id}")

    # Extract from_ref and to_ref
    from_ref_data = data.get("from_ref")
    to_ref_data = data.get("to_ref")

    if not from_ref_data or not to_ref_data:
        error_msg = f"Relationship sync missing from_ref or to_ref: {data}"
        logger.error(f"[RELATIONSHIP_SYNC] {error_msg}")
        return ApiFailResponse(message=error_msg)

    # Parse TypeIds
    from_type = from_ref_data.get("type")
    from_id = from_ref_data.get("id")
    to_type = to_ref_data.get("type")
    to_id = to_ref_data.get("id")

    if not all([from_type, from_id, to_type, to_id]):
        error_msg = f"Invalid ref structure: from_ref={from_ref_data}, to_ref={to_ref_data}"
        logger.error(f"[RELATIONSHIP_SYNC] {error_msg}")
        return ApiFailResponse(message=error_msg)

    from_entity_cls = SchemaRegistry.get_entity_cls(from_type)
    to_entity_cls = SchemaRegistry.get_entity_cls(to_type)

    if not from_entity_cls or not to_entity_cls:
        error_msg = f"Unknown entity types: from_type={from_type}, to_type={to_type}"
        logger.error(f"[RELATIONSHIP_SYNC] {error_msg}")
        return ApiFailResponse(message=error_msg)

    try:
        if operation == SyncOperation.CREATE:
            # Get parent entity by uname
            parent_entity = await from_entity_cls.get_by_uname(from_id)
            if not parent_entity:
                error_msg = f"Parent entity not found: {from_type}:{from_id}"
                logger.warning(f"[RELATIONSHIP_SYNC] {error_msg}")
                return ApiFailResponse(message=error_msg)

            # Get child entity by uname
            child_entity = await to_entity_cls.get_by_uname(to_id)
            if not child_entity:
                error_msg = f"Child entity not found: {to_type}:{to_id}"
                logger.warning(f"[RELATIONSHIP_SYNC] {error_msg}")
                return ApiFailResponse(message=error_msg)

            # Create the relationship based on type
            if relationship_type == RelationshipType.CHILD:
                await parent_entity.attach_child(child_entity.typeid)
                logger.info(
                    f"[RELATIONSHIP_SYNC] Created child relationship: {parent_entity.typeid} -> {child_entity.typeid}"
                )
            else:
                logger.warning(f"[RELATIONSHIP_SYNC] Unsupported relationship type: {relationship_type}")
                return ApiSuccessResponse(
                    data={"status": "received", "warning": f"Unsupported relationship type: {relationship_type}"}
                )

            return ApiSuccessResponse(data={"status": "created", "relationship_type": relationship_type})

        elif operation == SyncOperation.DELETE:
            # Get parent entity
            parent_entity = await from_entity_cls.get_by_uname(from_id)
            if not parent_entity:
                return ApiSuccessResponse(data={"status": "skipped", "reason": "parent not found"})

            # Get child entity
            child_entity = await to_entity_cls.get_by_uname(to_id)
            if not child_entity:
                return ApiSuccessResponse(data={"status": "skipped", "reason": "child not found"})

            # Remove the relationship
            if relationship_type == RelationshipType.CHILD:
                await parent_entity.remove_child(child_entity.typeid)
                logger.info(
                    f"[RELATIONSHIP_SYNC] Deleted child relationship: {parent_entity.typeid} -> {child_entity.typeid}"
                )
            else:
                return ApiSuccessResponse(
                    data={"status": "received", "warning": f"Unsupported relationship type: {relationship_type}"}
                )

            return ApiSuccessResponse(data={"status": "deleted", "relationship_type": relationship_type})

        else:
            logger.info(f"[RELATIONSHIP_SYNC] Unsupported operation: {operation}")
            return ApiSuccessResponse(data={"status": "received", "operation": operation})

    except Exception as e:
        error_msg = f"Error creating relationship: {e}"
        logger.error(f"[RELATIONSHIP_SYNC] {error_msg}", exc_info=True)
        return ApiFailResponse(message=error_msg)



async def _reflect_entity(
    record_type: str,
    operation: SyncOperation,
    payload: dict,
) -> Tuple[ApiSuccessResponse | ApiFailResponse | None, Optional[str]]:
    """Create, update, or delete any registered entity type from a hook_op event.

    Uses the FsRecord ``id`` as the entity ``uname`` for idempotent lookup.

    Returns a ``(response, warning)`` tuple.  *warning* is non-None when the
    operation is semantically questionable (e.g. CREATE for an existing uname).
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    external_id = payload.get("id")
    if not external_id:
        logger.warning("[_reflect_entity] No 'id' in payload, skipping")
        return None, None

    entity_cls = SchemaRegistry.get_entity_cls(record_type)
    if entity_cls is None or not callable(entity_cls) or not hasattr(entity_cls, "get_by_uname"):
        warning = f"Unregistered entity type: {record_type}"
        logger.warning(f"[_reflect_entity] {warning}")
        return ApiSuccessResponse(data={"status": "received", "warning": warning}), warning

    logger.info(f"[_reflect_entity] type={record_type} op={operation} external_id={external_id}")

    # Get @local project for attaching new entities
    project = None
    try:
        from flow_sdk.server.routes.bootstrap import get_desktop_project

        project = await get_desktop_project()
    except ImportError:
        logger.debug("[_reflect_entity] bootstrap module not available for project lookup")

    logger.info(
        f"[_reflect_entity] project={project.id if project else None}, project_name={project.name if project else None}"
    )
    warning: Optional[str] = None

    try:
        if operation == SyncOperation.CREATE:
            existing = await entity_cls.get_by_uname(external_id)
            if existing:
                warning = f"CREATE with existing uname={external_id}, treating as UPDATE"
                logger.warning(f"[_reflect_entity] {warning}")
                _apply_entity_fields(existing, payload)
                await existing.save()
                return ApiSuccessResponse(data={f"{record_type}_id": existing.id, "action": "updated"}), warning

            init_fields = {
                k: v for k, v in payload.items() if k in entity_cls.model_fields and k not in _ENTITY_SYSTEM_FIELDS
            }
            entity = entity_cls(uname=external_id, **init_fields)

            # Save with project scope so frontend project-scoped queries can find the entity
            # and DataOp notifications reach the correct WatchedQuery listeners.
            scope = project
            if not scope:
                try:
                    from flow_sdk.request_context.methods import get_current_request_info

                    request_info = get_current_request_info()
                    scope = request_info.user if request_info and request_info.user else None
                except ImportError:
                    scope = None

            await entity.save(scope)
            if project:
                await project.attach_child(entity.typeid)
                logger.info(
                    f"[_reflect_entity] Created {record_type} {entity.id} (uname={external_id}) and attached to project {project.id}"
                )
            else:
                logger.warning(
                    f"[_reflect_entity] Created {record_type} {entity.id} (uname={external_id}) but NO PROJECT to attach to!"
                )
            return ApiSuccessResponse(data={f"{record_type}_id": entity.id, "action": "created"}), None

        elif operation == SyncOperation.UPDATE:
            existing = await entity_cls.get_by_uname(external_id)
            if not existing:
                warning = f"UPDATE for non-existing uname={external_id}"
                logger.warning(f"[_reflect_entity] {warning}")
                return None, warning

            # Log what's being updated
            update_fields = {k: v for k, v in payload.items() if k not in _ENTITY_SYSTEM_FIELDS}
            logger.info(f"[_reflect_entity] UPDATE payload for {record_type}: {update_fields}")

            _apply_entity_fields(existing, payload)
            await existing.save()

            # Force immediate notification to ensure frontend receives update
            try:
                await existing.notify_updated()
            except Exception:
                pass  # notify_updated may not exist on all entity types in flow-cli

            # Log final state after save
            if record_type == "task":
                logger.info(
                    f"[_reflect_entity] Updated task {existing.id}: status={existing.status}, title={existing.title}"
                )
            else:
                logger.info(f"[_reflect_entity] Updated {record_type} {existing.id} (uname={external_id})")
            return ApiSuccessResponse(data={f"{record_type}_id": existing.id, "action": "updated"}), None

        elif operation == SyncOperation.DELETE:
            existing = await entity_cls.get_by_uname(external_id)
            if not existing:
                warning = f"DELETE for non-existing uname={external_id}"
                logger.warning(f"[_reflect_entity] {warning}")
                return None, warning
            deleted_id = existing.id
            await entity_cls.delete_by_id(deleted_id)
            logger.info(f"[_reflect_entity] Deleted {record_type} {deleted_id} (uname={external_id})")
            return ApiSuccessResponse(data={f"{record_type}_id": deleted_id, "action": "deleted"}), None

    except Exception as e:
        logger.error(f"[_reflect_entity] Failed to reflect {record_type} {external_id}: {e}", exc_info=True)
        return ApiFailResponse(message=f"Entity reflection failed: {e}"), None

    return None, None


async def _handle_hook_op_event(
    sync_payload: HookOpPayload,
) -> ApiSuccessResponse | ApiFailResponse:
    """Route a hook_op EVENT to the appropriate handler."""
    event_name = sync_payload.event_name
    record_type = sync_payload.type

    if record_type == "skill":
        if event_name == "skill_activated":
            notification_fields = sync_payload.event_data.get("notification", {})
            notification = SkillNotification(**notification_fields)
            logger.info(f"Skill notification: {notification.skill_name} triggered in {notification.folder_path}")
            return ApiSuccessResponse(
                data={"status": "received", "routed_to": 0, "notification": notification.model_dump()}
            )

        if event_name in ("started_generating_skill", "skill_ready"):
            context_fields = sync_payload.event_data.get("context", {})
            logger.info(
                f"Activation rules event: {event_name} - skill={context_fields.get('skill_name')}, "
                f"session={context_fields.get('session_id')}"
            )
            return ApiSuccessResponse(
                data={
                    "status": "received",
                    "routed_to": 0,
                    "event": {"type": event_name, "context": context_fields},
                }
            )

        if event_name in ("flow_tag", "skillit called"):
            # Task entity reflection for flow_tag events
            flow_value = sync_payload.data
            element_type = event_name
            if isinstance(flow_value, dict) and element_type.startswith("task"):
                try:
                    from flow_sdk.builtin.task import TaskEventType

                    op = SyncOperation.CREATE if element_type == TaskEventType.TASK_CREATED else SyncOperation.UPDATE
                    entity_result, _warning = await _reflect_entity("task", op, flow_value)
                    if isinstance(entity_result, ApiSuccessResponse):
                        return entity_result
                except ImportError:
                    logger.debug("Task entity not available for flow_tag reflection")

            logger.debug(f"hook_op event: {event_name}")
            return ApiSuccessResponse(data={"status": "received", "routed_to": 0})

    if record_type == "log":
        logger.info(f"Skillit log event: {event_name or 'unknown'}")
        return ApiSuccessResponse(data={"status": "received"})

    logger.info(f"[hook_op] Unhandled event: type={record_type}, event_name={event_name}")
    return ApiSuccessResponse(data={"status": "received", "event_name": event_name})


async def _handle_hook_op_invoke(
    sync_payload: HookOpPayload,
) -> ApiSuccessResponse | ApiFailResponse:
    """Handle hook_op INVOKE — task reflection for element_type.startswith('task')."""
    element_type = sync_payload.type
    flow_value = sync_payload.data

    if isinstance(flow_value, dict) and element_type.startswith("task"):
        try:
            from flow_sdk.builtin.task import TaskEventType

            op = SyncOperation.CREATE if element_type == TaskEventType.TASK_CREATED else SyncOperation.UPDATE
            entity_result, _warning = await _reflect_entity("task", op, flow_value)
            if isinstance(entity_result, ApiSuccessResponse):
                return entity_result
            if isinstance(entity_result, ApiFailResponse):
                logger.warning(f"[handle_hook_op_invoke] _reflect_entity failed: {entity_result.message}")
        except ImportError:
            logger.debug("Task entity not available for invoke reflection")

    logger.info(f"hook_op invoke: type={element_type}")
    return ApiSuccessResponse(data={"status": "received", "routed_to": 0})


async def handle_hook_op(
    sync_payload: HookOpPayload,
) -> ApiSuccessResponse | ApiFailResponse:
    """Handle hook_op webhook -- unified CRUD+event+invoke+log dispatch."""
    record_type = sync_payload.type
    operation = sync_payload.operation
    resource_type = sync_payload.resource_type

    # Events -- delegate to event handler routing
    if operation == SyncOperation.EVENT:
        result = await _handle_hook_op_event(sync_payload)
        await _broadcast_to_sniffer(
            {
                "webhook_type": "hook_op",
                "type": record_type,
                "operation": str(operation),
                "id": sync_payload.id,
                "data": sync_payload.data,
                "execution_scope": sync_payload.execution_scope,
            },
            "hook_op",
        )
        return result

    # Invoke -- task reflection and other invocation-style operations
    if operation == SyncOperation.INVOKE:
        result = await _handle_hook_op_invoke(sync_payload)
        await _broadcast_to_sniffer(
            {"webhook_type": "hook_op", "type": record_type, "operation": operation, "id": sync_payload.id},
            "hook_op",
        )
        return result

    # Log -- accept and acknowledge
    if operation == SyncOperation.LOG:
        logger.info(f"hook_op log: type={record_type}, id={sync_payload.id}")
        return ApiSuccessResponse(data={"status": "received"})

    # Relationships -- handle parent-child and other graph edges
    if sync_payload.is_relationship:
        return await _handle_relationship_sync(sync_payload)

    # CRUD (CREATE, UPDATE, DELETE) -- generic entity sync
    if operation in (SyncOperation.CREATE, SyncOperation.UPDATE, SyncOperation.DELETE):
        payload = {**sync_payload.data, "id": sync_payload.id}
        result, warning = await _reflect_entity(record_type, operation, payload)

        # Broadcast to frontend - include warnings or errors
        error_msg = None
        if isinstance(result, ApiFailResponse):
            error_msg = result.message

        await _broadcast_to_sniffer(
            {"webhook_type": "hook_op", "type": record_type, "operation": operation, "id": sync_payload.id},
            "hook_op",
            warning=warning or error_msg,
        )

        if result is not None:
            return result
        return ApiSuccessResponse(data={"status": "received"})

    # Unknown operation
    logger.info(
        f"[hook_op] type={record_type}, operation={operation}, id={sync_payload.id}, resource_type={resource_type}"
    )
    return ApiSuccessResponse(data={"status": "received"})


# ---------------------------------------------------------------------------
# Main action entry point
# ---------------------------------------------------------------------------


async def listen_action(request):
    """
    Receive webhook data and route to the appropriate handler.

    Expected JSON body::

        {"webhook_type": "<type>", "webhook_payload": { ... }}

    URL pattern: POST /api/v1/webhook/listen
    """

    try:
        json_data = await request.json()
        envelope = WebhookPayload(**json_data)
        webhook_type = envelope.webhook_type
        raw_payload = envelope.webhook_payload

        # HOOK_OP v2 envelope -- unified CRUD+event+invoke+log dispatch
        if webhook_type == WebhookType.HOOK_OP:
            try:
                sync_payload = HookOpPayload(**raw_payload)
                logger.info(
                    f"[HOOK_OP] Valid type={raw_payload.get('type')} op={raw_payload.get('operation')} id={raw_payload.get('id')}"
                )
            except Exception as e:
                logger.error(
                    f"[HOOK_OP] INVALID type={raw_payload.get('type')} op={raw_payload.get('operation')} id={raw_payload.get('id')}"
                )
                logger.error(f"[HOOK_OP] Error: {e}")
                logger.error(f"[HOOK_OP] Full payload: {raw_payload}")
                raise
            flow_value = {"webhook_type": "hook_op", **raw_payload}
            await _route_to_source_process(flow_value, execution_scope=sync_payload.execution_scope)
            return await handle_hook_op(sync_payload)

        # AGENT_HOOK -- parse and dispatch
        if webhook_type == WebhookType.AGENT_HOOK:
            # Enrich hook_data with absolute skill usage count from ~/.claude.json.
            # Mutate raw_payload["hook_data"] so both _broadcast_to_sniffer AND
            # handle_agent_hook (which re-reads webhook_data.hook_data) see the count.
            hook_data_dict = raw_payload.get("hook_data") or {}

            data = AgentHookData(**raw_payload)
            payload_data = {"webhook_type": "agent_hook", **raw_payload}
            skip_hook_id = raw_payload.get("agent_hook_id")
            await _broadcast_to_sniffer(payload_data, "agent_hook", skip_hook_id=skip_hook_id)
            # Route agent_hook events to source process via session_id
            agent_session_id = hook_data_dict.get("session_id")
            await _route_to_source_process(payload_data, session_id=agent_session_id)
            return await handle_agent_hook(data)

        return ApiFailResponse(message=f"Unknown webhook type: {webhook_type}")

    except (ValueError, ValidationError) as e:
        logger.error(f"Error parsing webhook data: {e}", exc_info=True)
        return ApiFailResponse(message=str(e))
    except ClientDisconnect:
        # Hook process sent fire-and-forget; body unreadable after disconnect — ignore.
        return ApiSuccessResponse(data={"status": "disconnected"})
    except Exception as e:
        logger.error(f"Error in listen action: {e}", exc_info=True)
        return ApiFailResponse(message=str(e))
