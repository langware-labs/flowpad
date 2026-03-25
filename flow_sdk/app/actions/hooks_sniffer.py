"""Hooks sniffer action - hook event monitoring.

Ported from FlowPad: flowpad/hub/app/actions/hooks_sniffer.py
Simplified for desktop mode.
"""

import logging

from pydantic import BaseModel

from flow_sdk.builtin.agent_hook import AgentHook, AgentProvider, HookEventType, HookScope
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
    "hook_name": "flowpad_sniffer",
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
        if not hook:
            return ApiSuccessResponse(data=HooksSnifferStatus(enabled=False).model_dump())
        return ApiSuccessResponse(
            data=HooksSnifferStatus(enabled=True, hook_id=hook.id, hook_scope=hook.hook_scope).model_dump()
        )

    if method == "post":
        hook = await _create_or_update_sniffer_hook(request_info.user)
        try:
            await hook.apply()
        except Exception as e:
            logger.warning(f"hooks-sniffer apply warning: {e}")
        return ApiSuccessResponse(
            data=HooksSnifferStatus(enabled=True, hook_id=hook.id, hook_scope=hook.hook_scope).model_dump()
        )

    if method == "delete":
        hook = await _get_sniffer_hook()
        if hook:
            hook.hook_name = "flowpad_sniffer"  # Ensure proper sniffer cleanup for legacy hooks
            await hook.delete()  # delete() calls unapply() internally
        return ApiSuccessResponse(data=HooksSnifferStatus(enabled=False).model_dump())

    return ApiFailResponse(message=f"Method not allowed: {method}")
