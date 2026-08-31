import logging
from pathlib import Path
from typing import Any, ClassVar, Optional, Union

from starlette.requests import Request

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.builtin.hook_models import (
    ErrorMessage,
    RelationshipSubAction,
    SuccessMessage,
)

# Hook vocabulary lives in ``flow_sdk.builtin.hooks.types`` — the bottom of the
# hook stack, which imports no trigger code. Re-exported here so the many call
# sites that import these names from ``agent_hook`` keep working.
from flow_sdk.builtin.hooks.types import (
    ALL_HOOK_EVENTS,
    DEFAULT_LISTENED_HOOKS,
    HOOK_EVENTS_NO_MATCHER,
    HOOK_EVENTS_WITH_MATCHER,
    AgentProvider,
    HookEventType,
    HookScope,
)
from flow_sdk.core import action
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.flowpad_types.enums.entity_enums import BuiltInRelationshipTypes, RelationshipDirection
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

#: The hook vocabulary is re-exported, not redefined — one definition lives in
#: ``hooks.types``. Listed here so it reads as this module's public surface
#: rather than as unused imports; many call sites still import it from here.
__all__ = [
    "ALL_HOOK_EVENTS",
    "DEFAULT_LISTENED_HOOKS",
    "HOOK_EVENTS_NO_MATCHER",
    "HOOK_EVENTS_WITH_MATCHER",
    "AgentHook",
    "AgentProvider",
    "HookEventType",
    "HookScope",
]


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
