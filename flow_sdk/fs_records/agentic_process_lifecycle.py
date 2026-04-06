"""AgenticProcessLifecycleStatus — backend-owned control-plane FSM for process lifecycle."""

from __future__ import annotations

from flow_sdk._compat import StrEnum


class AgenticProcessLifecycleStatus(StrEnum):
    NEW = "new"
    STARTING = "starting"
    LIVE = "live"
    STOPPING = "stopping"
    STOPPED = "stopped"
    FAILED = "failed"


_ACTIVE_STATUSES: frozenset[AgenticProcessLifecycleStatus] = frozenset({
    AgenticProcessLifecycleStatus.STARTING,
    AgenticProcessLifecycleStatus.LIVE,
    AgenticProcessLifecycleStatus.STOPPING,
})

_STARTABLE_STATUSES: frozenset[AgenticProcessLifecycleStatus] = frozenset({
    AgenticProcessLifecycleStatus.NEW,
    AgenticProcessLifecycleStatus.STOPPED,
    AgenticProcessLifecycleStatus.FAILED,
})


def is_active(status: AgenticProcessLifecycleStatus) -> bool:
    return status in _ACTIVE_STATUSES


def is_startable(status: AgenticProcessLifecycleStatus) -> bool:
    return status in _STARTABLE_STATUSES
