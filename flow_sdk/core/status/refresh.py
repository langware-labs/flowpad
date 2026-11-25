"""Refresh status facts -- the only path that probes. An action, never a GET."""

from __future__ import annotations

import asyncio

from flow_sdk.core.status.push import publish_status_changed

#: Runs that install or update a CLI (process id -> the kinds to re-discover; None = all).
_CLI_CHANGING_RUNS: dict[str, list[str] | None] = {}
_TASKS: set[asyncio.Task] = set()


async def refresh_status(kinds: list[str] | None = None) -> None:
    """Re-discover the given capability kinds (all when None) and re-probe their logins.

    ``run_discovery`` re-locates each CLI on the login-shell PATH and then asks every
    INSTALLED harness whether it is signed in (``_resolve_login_states``), writing each
    verdict through the one login writer. A CLI installed or signed into outside Flowpad
    is picked up here.
    """
    from flow_sdk.core.capabilities.discovery import run_discovery  # noqa: PLC0415
    from flow_sdk.core.status.build import build_status  # noqa: PLC0415
    from flow_sdk.instance_settings.llm_endpoint import fetch_hub_llm_endpoints  # noqa: PLC0415

    # Every client re-reads status, funding and connections on a push, and screens refresh on
    # arrival -- so a sweep that found what was already known says nothing.
    before = await build_status()
    await run_discovery(kinds)
    # Refresh readable budgets without treating absence as invocation revocation.
    await fetch_hub_llm_endpoints()
    if await build_status() != before:
        publish_status_changed()


def refresh_status_after(process_id: str, kinds: list[str] | None = None) -> None:
    """Mark the run ``process_id`` as one that installs or updates a CLI: refresh when a turn of it ends.

    The status record holds the version the last sweep read, so without this an update that
    worked keeps showing as available until the next restart.
    """
    _CLI_CHANGING_RUNS[process_id] = kinds


def turn_ended(process_id: str) -> None:
    """A turn of ``process_id`` ended -- called from the process's one turn-end seam."""
    if process_id not in _CLI_CHANGING_RUNS:
        return
    task = asyncio.create_task(
        refresh_status(_CLI_CHANGING_RUNS[process_id]), name=f"status-refresh-after:{process_id[:8]}"
    )
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)
