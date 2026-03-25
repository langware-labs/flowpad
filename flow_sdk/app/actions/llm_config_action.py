"""LLM configuration status action.

Ported from FlowPad: flowpad/hub/app/actions/llm_config_action.py
Checks if an LLM (Claude Code) is configured and returns auth details.
"""

import logging
from typing import Optional

from fastapi import HTTPException
from pydantic import BaseModel

from flow_sdk.actions import action
from flow_sdk.builtin.faas.claude_code_auth import (
    ClaudeCodeAuthStatus,
    detect_claude_code_auth,
)
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiResponse, ApiSuccessResponse


class LlmConfigStatus(BaseModel):
    """Extended response for is-llm-configured action."""

    is_configured: bool
    claude_code_auth: Optional[ClaudeCodeAuthStatus] = None


@action.get(action_name="is-llm-configured", types="user")
async def is_llm_configured() -> ApiResponse[LlmConfigStatus]:
    """Check LLM configuration status including Claude Code auth details.

    Returns:
        ApiResponse with data containing:
        - is_configured: bool (true if any auth method is available)
        - claude_code_auth: Full auth status with method, subscription, user profile, etc.
    """
    request_info = get_current_request_info()
    if not request_info or not request_info.user:
        raise HTTPException(status_code=401, detail="User not authenticated")

    claude_auth = await detect_claude_code_auth()
    is_configured = claude_auth.is_authenticated

    oauth_summary = "N/A"
    if claude_auth.oauth_info:
        oi = claude_auth.oauth_info
        oauth_summary = (
            f"expires_at={oi.expires_at}, is_expired={oi.is_expired}, "
            f"subscription={oi.subscription_type}, scopes={oi.scopes}"
        )

    logging.info(
        f"[LLM Config Check] RESULT: is_configured={is_configured}, "
        f"auth_method={claude_auth.auth_method}, "
        f"credentials_source={claude_auth.credentials_source}, "
        f"oauth=[{oauth_summary}], "
        f"error={claude_auth.error}"
    )

    return ApiSuccessResponse(
        message="LLM configuration status checked",
        data=LlmConfigStatus(is_configured=is_configured, claude_code_auth=claude_auth),
    )
