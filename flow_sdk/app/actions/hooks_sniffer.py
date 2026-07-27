"""Hooks sniffer action - hook event monitoring.

Ported from FlowPad: flowpad/hub/app/actions/hooks_sniffer.py
Simplified for desktop mode.
"""

import logging

from pydantic import BaseModel

from flow_sdk.builtin.agent_hook import AgentHook, AgentProvider, HookEventType, HookScope
from flow_sdk.builtin.claude_settings_sync import (
    SNIFFER_HOOK_NAME as SNIFFER_COMMAND_NAME,
    purge_sniffer_entries_from_settings,
)
from flow_sdk.core import action
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)

SNIFFER_HOOK_NAME = "Hooks Sniffer"
SNIFFER_HOOK_DESCRIPTION = "FlowPad managed sniffer hook (catch-all)"


class HooksSnifferStatus(BaseModel):
    enabled: bool
    hook_id: str | None = None
    hook_scope: str | None = None
    #: Sniffer commands are present in ~/.claude/settings.json — the sniffer is
    #: actually running, regardless of what this instance's DB holds (another
    #: instance on this machine may have installed them).
    installed: bool = False


def sniffer_installed() -> bool:
    """Whether the harness settings file currently carries sniffer hooks."""
    from flow_sdk.builtin.claude_settings_sync import sniffer_installed_in_settings  # noqa: PLC0415

    return sniffer_installed_in_settings(HookScope.USER)


def _status(hook: AgentHook | None, installed: bool) -> HooksSnifferStatus:
    """The one status shape. "On" means Claude Code is firing hooks at us — an
    installed settings entry counts even when no local entity backs it."""
    return HooksSnifferStatus(
        enabled=bool(hook) or installed,
        hook_id=hook.id if hook else None,
        hook_scope=hook.hook_scope if hook else None,
        installed=installed,
    )


async def _get_sniffer_hook() -> AgentHook | None:
    return await AgentHook.get_one(
        {
            "name": SNIFFER_HOOK_NAME,
            "provider": AgentProvider.CLAUDE_CODE,
            "hook_scope": HookScope.USER,
        }
    )


_SNIFFER_EXPECTED = {
    "description": SNIFFER_HOOK_DESCRIPTION,
    "provider": AgentProvider.CLAUDE_CODE,
    "hook_scope": HookScope.USER,
    "event": HookEventType.SESSION_START,
    "matcher": {"pattern": "*"},
    "enabled": True,
    "hook_name": SNIFFER_COMMAND_NAME,
    "uname": "sniffer",
}


async def _create_or_update_sniffer_hook(owner) -> AgentHook:
    hook = await _get_sniffer_hook()
    if hook is None:
        hook = AgentHook(**{"name": SNIFFER_HOOK_NAME, **_SNIFFER_EXPECTED})
        await hook.save(owner)
    else:
        # Only write if any field differs — avoids a SQLite write on every bootstrap
        needs_save = any(getattr(hook, k, None) != v for k, v in _SNIFFER_EXPECTED.items())
        if needs_save:
            for k, v in _SNIFFER_EXPECTED.items():
                setattr(hook, k, v)
            await hook.save(owner)
    return hook


@action.all(action_name="hooks-sniffer", methods=["get", "post", "delete"], types="all")
async def hooks_sniffer() -> ApiSuccessResponse | ApiFailResponse:
    """Hook event monitoring action.

    GET: Check if sniffer hook is enabled
    POST: Enable sniffer hook
    DELETE: Disable sniffer hook
    """
    request_info = get_current_request_info()
    if request_info is None:
        return ApiFailResponse(message="Request info not available")

    method = request_info.request.method.lower()

    if method == "get":
        hook = await _get_sniffer_hook()
        return ApiSuccessResponse(data=_status(hook, sniffer_installed()).model_dump())

    if method == "post":
        hook = await _create_or_update_sniffer_hook(request_info.user)
        installed = True
        try:
            await hook.apply()
        except Exception as e:
            logger.warning(f"hooks-sniffer apply warning: {e}")
            installed = sniffer_installed()
        return ApiSuccessResponse(data=_status(hook, installed).model_dump())

    if method == "delete":
        hook = await _get_sniffer_hook()
        if hook:
            hook.hook_name = SNIFFER_COMMAND_NAME  # Ensure proper sniffer cleanup for legacy hooks
            await hook.delete()  # delete() calls unapply() internally
        # Unconditional: the settings file can hold sniffer entries written by
        # another instance, and those keep firing until they're removed here.
        purge_sniffer_entries_from_settings(HookScope.USER)
        return ApiSuccessResponse(data=_status(None, installed=False).model_dump())

    return ApiFailResponse(message=f"Method not allowed: {method}")
