"""Refresh status facts -- the only path that probes. An action, never a GET."""

from __future__ import annotations

from flow_sdk.core.status.push import publish_status_changed


async def refresh_status(kinds: list[str] | None = None) -> None:
    """Re-discover the given capability kinds (all when None) and re-probe their logins.

    ``run_discovery`` re-locates each CLI on the login-shell PATH and then asks every
    INSTALLED harness whether it is signed in (``_resolve_login_states``), writing each
    verdict through the one login writer. A CLI installed or signed into outside Flowpad
    is picked up here.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.hub_endpoint_binding import (  # noqa: PLC0415
        prune_dead_binding,
    )
    from flow_sdk.core.capabilities.discovery import run_discovery  # noqa: PLC0415

    await run_discovery(kinds)
    await prune_dead_binding()
    publish_status_changed()
