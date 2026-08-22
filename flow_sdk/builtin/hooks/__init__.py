"""Hook configuration, subscription and delivery — one interface, every scope."""

from flow_sdk.builtin.hooks.callbacks import AgentHookCallback, Unsubscribe
from flow_sdk.builtin.hooks.manager import HooksManager, get_hook_manager
from flow_sdk.builtin.hooks.types import (
    AgentHookResponse,
    BlockResponse,
    ContextResponse,
    HookCapability,
    HookEventType,
    HookInfo,
    HookScope,
    PermissionBehavior,
    PermissionResponse,
)

__all__ = [
    "AgentHookCallback",
    "AgentHookResponse",
    "BlockResponse",
    "ContextResponse",
    "HookCapability",
    "HookEventType",
    "HookInfo",
    "HookScope",
    "HooksManager",
    "PermissionBehavior",
    "PermissionResponse",
    "Unsubscribe",
    "get_hook_manager",
]
