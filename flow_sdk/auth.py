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
    """Clear this FlowPad instance's Hub login.

    Credentials only — deliberately narrower than the app's Logout button,
    which also drops the hub's local copy of the inbox via ``clear_user_data``.
    A script ending its session is not a user asking for their data to be
    removed from the machine; callers that want that ask for it by name.
    """
    from flow_sdk.cli.auth.cloud_login import clear_cloud_credentials

    await clear_cloud_credentials()


__all__ = ["LoginRequired", "login", "logout"]
