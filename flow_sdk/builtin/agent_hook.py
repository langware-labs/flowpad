import logging
from flow_sdk._compat import StrEnum
from pathlib import Path
from typing import Any, ClassVar, Optional, Union

from starlette.requests import Request

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.api.type_id import TypeId
from flow_sdk.builtin.hook_models import (
    ErrorMessage,
    ExecutedAction,
    HookEventData,
    RelationshipSubAction,
    SuccessMessage,
    WebhookHandleResult,
)
from flow_sdk.builtin.trigger import Trigger
from flow_sdk.core import action
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.core.flow.models.webhook_flow_data import AgentHookData
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.flowpad_types.enums.entity_enums import BuiltInRelationshipTypes, RelationshipDirection
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse


class HookScope(StrEnum):
    """Configuration scope for agent hooks."""

    USER = "user"  # ~/.claude/settings.json (or equivalent)
    PROJECT = "project"  # .claude/settings.json (or equivalent)
    LOCAL = "local"  # .claude/settings.local.json (or equivalent)


class AgentProvider(StrEnum):
    """Agent provider types."""

    CLAUDE_CODE = "claude_code"
    # Future: CURSOR = "cursor", etc.


class HookEventType(StrEnum):
    """Types of hook events from Claude Code.

    Based on Claude Code hooks documentation:
    https://code.claude.com/docs/en/hooks
    """

    # Session lifecycle events
    SESSION_START = "SessionStart"
    SESSION_END = "SessionEnd"

    # User interaction events
    USER_PROMPT_SUBMIT = "UserPromptSubmit"
    NOTIFICATION = "Notification"

    # Tool events
    PRE_TOOL_USE = "PreToolUse"
    POST_TOOL_USE = "PostToolUse"
    POST_TOOL_USE_FAILURE = "PostToolUseFailure"
    PERMISSION_REQUEST = "PermissionRequest"

    # Agent stop/start events
    STOP = "Stop"
    STOP_FAILURE = "StopFailure"
    SUBAGENT_START = "SubagentStart"
    SUBAGENT_STOP = "SubagentStop"

    # Agent teams events
    TEAMMATE_IDLE = "TeammateIdle"
    TASK_CREATED = "TaskCreated"
    TASK_COMPLETED = "TaskCompleted"

    # Configuration events
    CONFIG_CHANGE = "ConfigChange"
    INSTRUCTIONS_LOADED = "InstructionsLoaded"

    # Worktree events
    WORKTREE_CREATE = "WorktreeCreate"
    WORKTREE_REMOVE = "WorktreeRemove"

    # Compaction events
    PRE_COMPACT = "PreCompact"
    POST_COMPACT = "PostCompact"

    # MCP elicitation events
    ELICITATION = "Elicitation"
    ELICITATION_RESULT = "ElicitationResult"

    # File system events
    CWD_CHANGED = "CwdChanged"
    FILE_CHANGED = "FileChanged"


# Hook events that don't use matchers (always fire on every occurrence)
HOOK_EVENTS_NO_MATCHER = [
    HookEventType.USER_PROMPT_SUBMIT,
    HookEventType.STOP,
    HookEventType.TEAMMATE_IDLE,
    HookEventType.TASK_COMPLETED,
    HookEventType.WORKTREE_CREATE,
    HookEventType.WORKTREE_REMOVE,
    HookEventType.CWD_CHANGED,
    HookEventType.FILE_CHANGED,
]

# Hook events that use matchers
HOOK_EVENTS_WITH_MATCHER = [
    HookEventType.PRE_TOOL_USE,
    HookEventType.POST_TOOL_USE,
    HookEventType.POST_TOOL_USE_FAILURE,
    HookEventType.PERMISSION_REQUEST,
    HookEventType.SESSION_START,
    HookEventType.SESSION_END,
    HookEventType.NOTIFICATION,
    HookEventType.SUBAGENT_START,
    HookEventType.SUBAGENT_STOP,
    HookEventType.STOP_FAILURE,
    HookEventType.PRE_COMPACT,
    HookEventType.POST_COMPACT,
    HookEventType.CONFIG_CHANGE,
    HookEventType.INSTRUCTIONS_LOADED,
    HookEventType.ELICITATION,
    HookEventType.ELICITATION_RESULT,
]

# All available hook events
ALL_HOOK_EVENTS = HOOK_EVENTS_NO_MATCHER + HOOK_EVENTS_WITH_MATCHER

# Default hooks to listen to — excludes worktree create event (which would replace the default behavior)
DEFAULT_LISTENED_HOOKS = [e for e in ALL_HOOK_EVENTS if e != HookEventType.WORKTREE_CREATE]


class AgentHook(Entity):
    """Entity representing a provider-agnostic agent hook configuration."""

    type: str = APIField(default=BuiltinEntityType.AGENT_HOOK.value)
    name: str = APIField()
    description: Optional[str] = APIField(None)
    provider: AgentProvider = APIField()
    hook_scope: HookScope = APIField()
    event: str = APIField(description="Hook event name (e.g., 'UserPromptSubmit', 'PreToolUse')")
    command: Optional[str] = APIField(None, description="Command to execute when hook triggers")
    matcher: Optional[dict[str, Any]] = APIField(None, description="Optional criteria for filtering hook events")
    enabled: bool = APIField(default=True)
    hook_file_vfs: Optional[str] = APIField(
        None, description="VFS path to settings file, e.g., 'vfs://user/.claude/settings.json'"
    )
    entry_index: int = APIField(default=0, description="Index of the entry within the event's entries list")
    hook_name: Optional[str] = APIField(
        None, description="Unique name for this hook within a settings file (used in flow_metadata.name)"
    )

    @property
    def is_sniffer(self) -> bool:
        """Whether this hook is a sniffer (catch-all) hook, derived from hook_name."""
        return self.hook_name == "flowpad_sniffer"

    @is_sniffer.setter
    def is_sniffer(self, value: bool) -> None:
        """Backward-compat setter: sets hook_name to 'flowpad_sniffer' when True."""
        if value:
            self.hook_name = "flowpad_sniffer"

    _api_visible: ClassVar[bool] = True
    _unique: ClassVar[list[str]] = []

    async def _resolve_project_path(self, project_path: Optional[Path] = None) -> Optional[Path]:
        """
        Resolve project path from project_id or use provided project_path.

        Args:
            project_path: Optional project path (deprecated, use project_id instead)

        Returns:
            Resolved project path or None
        """
        # Use project_id from payload if available, otherwise fall back to project_path parameter
        if project_path:
            return project_path

        if self.project_id:
            from flow_sdk.cli.flow_cli.utils.claude_paths import resolve_project_vfs_root_path

            return await resolve_project_vfs_root_path(self.project_id)

        return None

    async def add_trigger(self, trigger: Union[Entity, TypeId]) -> None:
        """Connect a trigger to this agent hook."""
        if isinstance(trigger, Entity):
            trigger_id = trigger.typeid
        else:
            trigger_id = trigger

        await self.save_relationship(
            to_e=trigger_id,
            relationship_or_str=BuiltInRelationshipTypes.ConnectedTo,
            direction=RelationshipDirection.Outgoing,
        )

    async def remove_trigger(self, trigger: Union[Entity, TypeId]) -> None:
        """Disconnect a trigger from this agent hook."""
        if isinstance(trigger, Entity):
            trigger_id = trigger.typeid
        else:
            trigger_id = trigger

        await self.delete_relationship(to_e=trigger_id, relationship=BuiltInRelationshipTypes.ConnectedTo)

    async def process_hook_event(self, hook_data: HookEventData) -> list[ExecutedAction]:
        """
        Process a hook event by checking all connected triggers.

        Executes matching triggers via execute_action() which:
        - Updates last_triggered timestamp
        - Increments counter for NOTIFY_ENTITY action type
        - Saves changes to database

        Args:
            hook_data: The hook event data to process

        Returns:
            List of executed actions from matching triggers
        """

        if not self.enabled:
            return []

        triggers = await self.get_triggers()
        matched_actions: list[ExecutedAction] = []

        for entity in triggers:
            trigger: Trigger = entity  # type: ignore
            if trigger.match(hook_data):
                # Execute trigger action (updates timestamp, increments counter, saves to DB)
                executed_action = await trigger.execute_action()
                matched_actions.append(executed_action)

        return matched_actions

    async def handle_webhook(self, webhook_data: AgentHookData) -> WebhookHandleResult:
        """
        Handle a webhook event for this agent hook.

        Processes the webhook data and invokes matching triggers.

        This is also the bus funnel for the hook family. Two emissions, and the
        distinction between them matters:

        * ONE ``hook.<event>`` per inbound webhook, carrying the match count.
          Emitted here rather than per trigger because a webhook that matches
          NOTHING is the common case and is otherwise invisible everywhere in
          the product — ``Trigger.match`` just returns falsy and the request
          ends. One-per-webhook also keeps this off the per-item lane.
        * ONE ``trigger.fired`` per MATCHED trigger, so a hook rule reads the
          same as a schedule or fsop rule on the events screen.

        No ``actor`` is stamped on either envelope: a global hook is harness-wide,
        so the process that happened to fire it is not a meaningful principal.

        In the old FlowPad cloud, this also created/looked up a Flow entity
        for session tracking via Flow.get_or_create_for_session().  In desktop
        mode the Flow entity is dead (replaced by AgenticProcess) and session
        tracking is not needed, so we skip it entirely.

        Args:
            webhook_data: The webhook data containing hook event information

        Returns:
            WebhookHandleResult with processing details
        """

        # Parse the hook data from webhook_data
        hook_data = HookEventData(**webhook_data.hook_data)

        # Extract session_id from hook data (for reporting only, no entity lookup)
        session_id = webhook_data.hook_data.get("session_id")

        # Get triggers connected to this AgentHook
        triggers = await self.get_triggers()

        # Invoke matching triggers
        from flow_sdk.builtin.trigger_on_tag import emit_hook_received, emit_trigger_fired

        executed_actions: list[ExecutedAction] = []
        matched_trigger_ids: list[str] = []
        for entity in triggers:
            trigger: Trigger = entity  # type: ignore
            result = await trigger.invoke(hook_data)
            if result:
                executed_actions.append(result)
                if trigger.id:
                    matched_trigger_ids.append(trigger.id)
                    emit_trigger_fired(
                        trigger.id, str(trigger.trigger_type),
                        trigger.name or trigger.id,
                        counter=trigger.counter,
                        action_types=[str(a.action_type) for a in trigger.actions],
                        detail={"hook_event": str(hook_data.hook_event_name or ""),
                                "agent_hook_id": self.id},
                        project_id=trigger.project_id,
                        scope_extra=[f"agent_hook:{self.id}"] if self.id else None,
                    )

        emit_hook_received(
            self.id or "",
            str(hook_data.hook_event_name or ""),
            matched=len(matched_trigger_ids),
            matched_trigger_ids=matched_trigger_ids,
            session_id=session_id,
        )

        return WebhookHandleResult(
            status="processed",
            matched_triggers=len(executed_actions),
            executed_actions=executed_actions,
            agentic_process_id=None,
            flow_id=None,
            session_id=session_id,
        )

    @action.all(action_name="trigger_action")
    async def trigger_action(self, request: Request) -> ApiResponse:
        """
        Handle trigger relationship management for this agent hook.

        Routes:
        - GET  /api/v1/graph/agent_hook/{id}/trigger_action        -> list connected triggers
        - POST /api/v1/graph/agent_hook/{id}/trigger_action/add    -> add trigger connection
        - POST /api/v1/graph/agent_hook/{id}/trigger_action/remove -> remove trigger connection
        """
        from flow_sdk.api.messages import HttpMethod

        request_info = get_current_request_info()
        if not request_info:
            return ApiFailResponse(message=ErrorMessage.REQUEST_INFO_NOT_AVAILABLE)

        method = request.method.upper()
        sub_action = request_info.sub_path

        if method == HttpMethod.GET.value:
            # List all triggers connected to this agent hook
            triggers = await self.get_triggers()
            return ApiSuccessResponse(data=[trigger.model_dump() for trigger in triggers])

        elif method == HttpMethod.POST.value:
            body = await request_info.get_post_data()
            if not body:
                return ApiFailResponse(message=ErrorMessage.REQUEST_BODY_REQUIRED)

            trigger_id = body.get("trigger_id")
            if not trigger_id:
                return ApiFailResponse(message=ErrorMessage.TRIGGER_ID_REQUIRED)

            try:
                trigger_typeid = TypeId.model_validate(trigger_id)
            except Exception as e:
                return ApiFailResponse(message=f"{ErrorMessage.INVALID_TRIGGER_ID_FORMAT}: {e}")

            if sub_action == RelationshipSubAction.ADD:
                await self.add_trigger(trigger_typeid)
                return ApiSuccessResponse(message=SuccessMessage.TRIGGER_CONNECTED)

            elif sub_action == RelationshipSubAction.REMOVE:
                await self.remove_trigger(trigger_typeid)
                return ApiSuccessResponse(message=SuccessMessage.TRIGGER_DISCONNECTED)

            else:
                return ApiFailResponse(message=f"{ErrorMessage.UNKNOWN_SUB_ACTION}: {sub_action}")

        return ApiFailResponse(message=f"{ErrorMessage.METHOD_NOT_ALLOWED} trigger")

    async def apply(self, project_path=None):
        """Sync this hook to the appropriate Claude Code settings.json.

        Call this explicitly after save() when you want the hook to appear
        in settings.json. Separates DB persistence from file integration.

        Args:
            project_path: Optional project path for PROJECT/LOCAL scopes
        """
        if self.provider != AgentProvider.CLAUDE_CODE:
            return

        resolved_project_path = await self._resolve_project_path(project_path)

        try:
            if self.is_sniffer:
                from flow_sdk.builtin.claude_settings_sync import sync_sniffer_hook_to_settings

                await sync_sniffer_hook_to_settings(self, project_path=resolved_project_path)
            else:
                from flow_sdk.builtin.claude_settings_sync import sync_hook_to_settings

                await sync_hook_to_settings(self, project_path=resolved_project_path)
        except Exception as e:
            logging.error(f"[AgentHook] Failed to apply hook to settings.json: {e}")

    async def unapply(self, project_path=None):
        """Remove this hook from the appropriate Claude Code settings.json.

        Call this explicitly before delete() or when you want the hook removed
        from settings.json. Separates DB persistence from file integration.

        Args:
            project_path: Optional project path for PROJECT/LOCAL scopes
        """
        if self.provider != AgentProvider.CLAUDE_CODE:
            return

        resolved_project_path = await self._resolve_project_path(project_path)

        try:
            if self.is_sniffer:
                from flow_sdk.builtin.claude_settings_sync import purge_sniffer_entries_from_settings

                # Marker-keyed, not entity-keyed: clears sniffer hooks whoever wrote them.
                purge_sniffer_entries_from_settings(self.hook_scope, project_path=resolved_project_path)
            else:
                from flow_sdk.builtin.claude_settings_sync import remove_hook_from_settings

                await remove_hook_from_settings(self, project_path=resolved_project_path)
        except Exception as e:
            logging.error(f"[AgentHook] Failed to unapply hook from settings.json: {e}")

    @classmethod
    async def delete_by_id(cls, eid: str):
        """Override delete_by_id to remove hook from settings.json before deletion."""
        hook = await cls.get_by_id(eid)
        if hook:
            await hook.unapply()
        return await super().delete_by_id(eid)

    async def delete(self):
        """Override delete to remove hook from Claude Code settings.json."""
        await self.unapply()
        return await super().delete()
