from .models import (
    CapabilityCheck,
    CapabilityKind,
    CapabilityResult,
    CapabilitySpec,
    CapabilityState,
    capability_kind_matches,
)
from .registry import (
    CapabilityRegistry,
    get_capability_registry,
    get_default_capability_specs,
)
from .summary import (
    CapabilitiesSummary,
    CapabilityAccess,
    CapabilityIntent,
    compute_capabilities_summary,
)


async def check_capability(kind: str) -> bool | None:
    """Tri-state readiness: True = available, False = not available,
    None = unknown (never tried, or the last probe errored — both retryable
    via :func:`setup_capability`). Reads the persisted row state; does NOT
    probe."""
    from flow_sdk.builtin.capability import Capability

    row = await Capability.get_by_kind(kind)
    state = row.state if row else CapabilityState.NONE.value
    if state == CapabilityState.AVAILABLE:
        return True
    if state == CapabilityState.NOT_AVAILABLE:
        return False
    return None


async def setup_capability(kind: str) -> bool:
    """Run the capability's setup (the registry ``install`` verb) to a
    terminal verdict: True ⇔ available afterwards.

    Thin orchestration over existing machinery: install spawns the headless
    agentic install process; its monitor re-runs discovery and persists the
    post-install state, so we await the monitor's verdict and re-read."""
    import asyncio

    from flow_sdk.core.capabilities.registry import _INSTALL_MONITOR_TASKS

    check = await get_capability_registry().install(kind)
    if check.result.process_id:
        # The install monitor task awaits the process, re-discovers, and
        # persists the terminal state — wait for the monitors to drain.
        monitors = [t for t in _INSTALL_MONITOR_TASKS if not t.done()]
        if monitors:
            await asyncio.wait(monitors)
    return (await check_capability(kind)) is True


__all__ = [
    "CapabilitiesSummary",
    "CapabilityAccess",
    "CapabilityCheck",
    "CapabilityIntent",
    "CapabilityKind",
    "CapabilityRegistry",
    "CapabilitySpec",
    "CapabilityResult",
    "CapabilityState",
    "capability_kind_matches",
    "check_capability",
    "compute_capabilities_summary",
    "get_capability_registry",
    "get_default_capability_specs",
    "setup_capability",
]
