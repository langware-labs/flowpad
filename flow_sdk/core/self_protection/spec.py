"""Shapes for the self-protection registry (FLOWPAD-2112).

A ``ProtectedProcessSpec`` is a value that travels (one per protected process,
persisted to ``<instance_dir>/runtime/<role>-<pid>.json``), so it is a
``DataSpec``, not a bare dict. Identity is ``pid`` + ``create_time`` — never an
image name, because the backend shares the ``python`` image with a user script.
"""
from __future__ import annotations

from enum import Enum

from flow_sdk.schema.data_spec.spec import DataSpec


class ProtectedRole(str, Enum):
    """What a protected process is, so a role-scoped sweep can reason about it."""

    BACKEND = "backend"
    MONITOR = "monitor"
    DESKTOP = "desktop"       # the Electron shell
    LIFECYCLE = "lifecycle"   # the transient restart/upgrade supervisor


class ProtectedProcessSpec(DataSpec):
    """One registered live FlowPad process that must not be killed by another."""

    role: ProtectedRole
    pid: int
    create_time: float        # psutil create_time: the anti-PID-reuse key
    instance: str             # FLOW_INSTANCE this process belongs to
    registered_at: float
