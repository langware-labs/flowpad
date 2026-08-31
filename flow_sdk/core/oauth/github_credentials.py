"""Public resolver for ONE user's GitHub OAuth credential (the publish path,
which acts for an explicit actor — no request/local/hub fallback)."""

from __future__ import annotations

from typing import Any


async def get_github_token(user_or_typeid: Any) -> str | None:
    """That user's token, or ``None`` when absent or unreadable."""
    from flow_sdk.core.oauth.provider_registry import GITHUB, token_for  # noqa: PLC0415

    return await token_for(GITHUB, user=user_or_typeid)


__all__ = ["get_github_token"]
