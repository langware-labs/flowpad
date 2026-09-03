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
from typing import Optional, Tuple

from pydantic import ValidationError
from starlette.requests import ClientDisconnect

from flow_sdk.api.api_types.identifier import is_valid_entity_id
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
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helper: broadcast to the @sniffer AgentHook for the frontend sniffer panel
# ---------------------------------------------------------------------------


async def _route_to_source_process(
    payload_data: dict,
    execution_scope: list | None = None,
) -> None:
    """Route a ``hook_op`` webhook event to the AgenticProcess that generated it.

    Identity comes from ``execution_scope`` — the worker's own
    ``FLOWPAD_EXECUTION_SCOPE``, carried in the payload by the ``flow`` verb that
    sent it. Global ``agent_hook`` events are deliberately NOT routed here: they
    are harness-wide and carry no process identity.
    """
    try:
        from flow_sdk.builtin.agentic_process import _send_flow_data_message
    except Exception:
        return

    # Translate the webhook payload to a canonical FlowData via the shared
    # dispatcher (agent_hook → convert_hook_event, hook_op → convert_hook_op_event).
    # The renderer reads attributes (`hook-op-event-name`, `workflow-label`,
    # `hook-message`, …) instead of digging into payload_data itself.
    from flow_sdk.app.actions._webhook_to_flowdata import convert_webhook_event

    fds = convert_webhook_event(payload_data)
    if not fds:
        return
    flow_msg = fds[0].model_dump(mode="python")

    # Route via execution_scope (hook_op events)
    for entry in execution_scope or []:
        target_type = entry.get("type") if isinstance(entry, dict) else None
        target_id = entry.get("id") if isinstance(entry, dict) else None
        if target_type and target_id:
            await _send_flow_data_message(target_type, target_id, flow_msg)


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

    # Translate via the shared dispatcher so the global sniffer view receives
    # the same canonical FlowData shape as the per-process trace gutter.
    from flow_sdk.app.actions._webhook_to_flowdata import convert_webhook_event

    fds = convert_webhook_event(payload_data)
    if not fds:
        return
    fd = fds[0]
    if element_type:
        fd.attributes["element-type"] = element_type
    if data_type:
        fd.attributes["data-type"] = data_type
    if warning:
        fd.attributes["warning"] = warning

    try:
        await sniffer_hook.emit_flow_data({"flow_value": fd.flow_value, "attributes": fd.attributes})
    except Exception as e:
        logger.debug(f"Sniffer broadcast failed (non-critical): {e}")


# ---------------------------------------------------------------------------
# Per-type handlers (simplified for desktop -- no Flow entity, no WS routing)
# ---------------------------------------------------------------------------


async def handle_agent_hook(webhook_data: AgentHookData) -> ApiSuccessResponse | ApiFailResponse:
    """Handle agent_hook webhook - process triggers connected to the AgentHook."""
    agent_hook_id = webhook_data.agent_hook_id
    if not agent_hook_id:
        return ApiFailResponse(message="agent_hook_id is required in payload")

    # Resolve hook fields first so a CwdChanged is still logged when the
    # AgentHook entity no longer exists in the DB. NOTHING here
    # resolves an AgenticProcess: a global hook is harness-wide, and the process
    # that happens to have fired it is not this tier's concern (process-scoped
    # hooks go through `handle_process_agent_hook`).
    hook_data_dict = webhook_data.hook_data if isinstance(webhook_data.hook_data, dict) else {}
    raw = hook_data_dict.get("raw_hook_data", {}) if isinstance(hook_data_dict.get("raw_hook_data"), dict) else {}

    hook_event_name = hook_data_dict.get("hook_event_name") or raw.get("hook_event_name", "")
    hook_session_id = hook_data_dict.get("session_id") or raw.get("session_id", "")
    cwd = raw.get("cwd")

    if hook_event_name == HookEventType.CWD_CHANGED:
        logger.info(f"[cwd change] to '{cwd}' (session={hook_session_id})")

    from flow_sdk.builtin.agent_hook import AgentHook

    # Load the AgentHook entity
    agent_hook = await AgentHook.get_by_id(agent_hook_id)
    if agent_hook is None:
        # Hook entity not found (stale hook registration) — nothing else to do
        logger.debug("AgentHook not found: %s — skipping entity-specific handling", agent_hook_id)
        return ApiSuccessResponse(data={})

    # Rule execution lives one layer ABOVE hooks: the bridge imports both, the
    # hook entity imports neither. Triggers may depend on hooks, never the reverse.
    from flow_sdk.builtin.trigger_hook_bridge import run_triggers_for_hook

    result = await run_triggers_for_hook(agent_hook, webhook_data)

    # Emit FlowData for live sniffer/watchers. Route through the canonical
    # ``convert_hook_event`` translator so the global sniffer view receives a
    # ``FlowData(element-type=status, source=sniffer, attributes={...})``.
    payload_data = {
        "webhook_type": "agent_hook",
        "agent_hook_id": agent_hook_id,
        "hook_data": webhook_data.hook_data,
        "hook_entry_id": webhook_data.hook_entry_id,
        "hook_metadata": webhook_data.hook_metadata,
        "hook_file_path": webhook_data.hook_file_path,
    }

    from flow_sdk.builtin.agentic_process.cli_drivers.claude.hook_to_flowdata import (
        convert_hook_event,
    )

    converted_fds = convert_hook_event(payload_data)
    for fd in converted_fds:
        try:
            await agent_hook.emit_flow_data({"flow_value": fd.flow_value, "attributes": fd.attributes})
        except Exception as e:
            logger.debug(f"AgentHook emit_flow_data failed (non-critical): {e}")

    return ApiSuccessResponse(data=result.model_dump())


async def handle_process_agent_hook(webhook_data: AgentHookData) -> ApiSuccessResponse | ApiFailResponse:
    """Deliver a direct process hook without entering global AgentHook routing."""
    process_id = webhook_data.agentic_process_id
    if not is_valid_entity_id(process_id):
        return ApiFailResponse(message="agentic_process_id must be a UUID v4/v5", status_code=400)

    from flow_sdk.builtin.agentic_process import AgenticProcess

    process = await AgenticProcess.get_by_id(process_id)
    if process is None:
        return ApiFailResponse(message=f"AgenticProcess not found: {process_id}", status_code=404)
    normalize = getattr(process.driver, "normalize_process_hook_data", None)
    if normalize is None:
        return ApiFailResponse(message="process hooks are unsupported by this worker", status_code=400)
    try:
        wrapped = webhook_data.hook_data
        raw_hook_data = wrapped.get("raw_hook_data") if isinstance(wrapped, dict) else None
        native = raw_hook_data if isinstance(raw_hook_data, dict) else wrapped
        canonical = normalize(process_id, native)
        answer = await process.on_hook(canonical)
    except (TypeError, ValueError, ValidationError) as exc:
        return ApiFailResponse(message=str(exc), status_code=400)

    # A callback's typed answer, rendered by the DRIVER into what this harness
    # should observe — exit code, stdout, stderr. The reporting CLI applies that
    # envelope verbatim under ``--wait-for-response``, which the projector adds
    # only for response-capable events. No callback (the common observer case)
    # means no opinion: the CLI is released immediately with the plain ack.
    if answer is not None:
        from flow_sdk.builtin.hooks.manager import normalize_event
        from flow_sdk.builtin.hooks.types import HOOK_OUTCOME_KEY

        render = getattr(process.driver, "render_hook_response", None)
        if render is None:
            logger.debug("%s renders no hook responses; dropping the answer", process.driver.name)
        else:
            try:
                event = normalize_event(canonical.hook_data.get("hook_event_name"))
                outcome = render(event, answer)
            except (NotImplementedError, TypeError, ValueError) as exc:
                # A callback answered an event the harness cannot hear. Log and
                # release the CLI rather than failing the turn over it.
                logger.warning("dropping hook response for %s: %s", process_id, exc)
            else:
                if not outcome.is_silent:
                    return ApiSuccessResponse(data={HOOK_OUTCOME_KEY: outcome.to_wire()})

    return ApiSuccessResponse(data={"received": True})


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
            existing_by_id = await entity_cls.get_one({"id": external_id})
            if existing_by_id:
                logger.debug(
                    f"[_reflect_entity] {record_type} id={external_id} already exists locally, skipping reflection"
                )
                return ApiSuccessResponse(data={f"{record_type}_id": existing_by_id.id, "action": "noop"}), None

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
            existing = await entity_cls.get_one({"id": external_id})
            if not existing:
                existing = await entity_cls.get_by_uname(external_id)
            if not existing:
                warning = f"UPDATE for non-existing id/uname={external_id}"
                logger.warning(f"[_reflect_entity] {warning}")
                return None, warning

            # Log what's being updated
            update_fields = {k: v for k, v in payload.items() if k not in _ENTITY_SYSTEM_FIELDS}
            logger.info(f"[_reflect_entity] UPDATE payload for {record_type}: {update_fields}")

            _apply_entity_fields(existing, payload)
            await existing.save()

            # Force immediate notification to ensure frontend receives update.
            # Only the "no such method" probe is silent; a notifier that exists
            # and fails is a real broadcast loss.
            try:
                await existing.notify_updated()
            except AttributeError:
                pass  # notify_updated may not exist on all entity types in flow-cli
            except Exception:
                logger.warning(
                    "[_reflect_entity] notify_updated failed for %s %s; the frontend "
                    "will not see this update until the next fetch",
                    record_type,
                    existing.id,
                    exc_info=True,
                )

            # Log final state after save
            if record_type == BuiltinEntityType.TASK.value:
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

    if record_type == BuiltinEntityType.SKILL.value:
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

    if record_type == BuiltinEntityType.LOG.value:
        logger.info(f"Skillit log event: {event_name or 'unknown'}")
        return ApiSuccessResponse(data={"status": "received"})

    # DEBUG, not INFO: this is the fall-through of the ENTITY-REFLECTION
    # dispatch, and reaching it is the normal case for the per-step sniffer
    # events (`flow_message_materialized`, `conversation_updated`). Those are
    # not dropped — `_route_to_source_process` above already delivered them to
    # the process that fired them, which is what drives the live UI. "Unhandled"
    # only means "no entity to reflect", so logging it at INFO put two lines per
    # agent message into the service log for a non-event.
    logger.debug(f"[hook_op] Unhandled event: type={record_type}, event_name={event_name}")
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
                # DEBUG: this says only "the payload parsed", on the success
                # path of an endpoint every agent message hits twice. The
                # INVALID branch below stays at ERROR — that one is news.
                logger.debug(
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
            # Direct process hooks are isolated from global AgentHook/sniffer
            # behavior. Branch before any legacy enrichment or fan-out.
            if raw_payload.get("agentic_process_id") is not None:
                return await handle_process_agent_hook(AgentHookData(**raw_payload))

            # Global hooks are harness-wide: they fan out to the sniffer view
            # only. They are deliberately NOT routed to whichever process fired
            # them — that bridge is what `handle_process_agent_hook` replaces.
            data = AgentHookData(**raw_payload)
            payload_data = {"webhook_type": "agent_hook", **raw_payload}
            skip_hook_id = raw_payload.get("agent_hook_id")
            await _broadcast_to_sniffer(payload_data, "agent_hook", skip_hook_id=skip_hook_id)
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
