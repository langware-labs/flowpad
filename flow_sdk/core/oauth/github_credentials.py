"""Public resolver for the desktop user's GitHub OAuth credential."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


async def get_github_token(user_or_typeid: Any) -> str | None:
    """Read the token written by desktop OAuth from the canonical SOD key."""
    try:
        from flow_sdk.builtin.user import User  # noqa: PLC0415
        from flow_sdk.request_context.methods import get_user_credentials  # noqa: PLC0415

        user = user_or_typeid if isinstance(user_or_typeid, User) else await User.get_by_typeid(user_or_typeid)
        if user is None:
            return None
        value = await get_user_credentials(user, "github_credentials", user.id)
        return str(value) if value else None
    except Exception:  # noqa: BLE001 — missing/locked credentials means disconnected
        # Credential errors are intentionally opaque: exception strings from a
        # provider/keychain are not a safe logging surface for secret handling.
        logger.warning("Could not resolve GitHub credentials")
        return None


__all__ = ["get_github_token"]
