"""Public Python SDK authentication helpers."""

from __future__ import annotations

from typing import Any


class LoginRequired(RuntimeError):
    """The requested SDK operation requires a FlowPad cloud login."""


async def login() -> dict[str, Any]:
    """Log this FlowPad instance into its configured Hub."""
    from flow_sdk.cli.auth.cloud_login import cloud_login

    return await cloud_login()


async def logout() -> None:
    """Clear this FlowPad instance's Hub login."""
    from flow_sdk.cli.auth.cloud_login import clear_cloud_credentials

    await clear_cloud_credentials()


__all__ = ["LoginRequired", "login", "logout"]
