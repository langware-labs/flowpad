"""Instance management: allocate, inspect, heal and tear down named Flowpad
dev/QA instances.

An *instance* is an isolated backend+frontend pair running out of this checkout,
with its own ``<flow_home>/instances/<name>/`` data dir, its own ports, and its
own hub user. Instances can be tagged into a **group** (typically one hub-UI
instance plus several backend instances) so a whole rig is torn down in one
command, and an instance can be **hub-ui** — a vite dev server pointed straight
at the hub with no local backend at all.

This package replaces ``scripts/instance_ctl.sh``, which is now a thin shim over
``flow instance ctl``. The rule that drove the rewrite is in ``liveness``: a
process is only ever signalled when it is ownership-verified as belonging to the
named instance. Port occupancy is evidence for a report, never for a kill.

Import cost matters — the CLI is invoked in loops by QA skills — so heavy
dependencies (psutil, rich, dotenv) are imported inside the functions that need
them, not at module import.
"""

from __future__ import annotations

from .errors import (
    InstanceError,
    KillFailed,
    NameInvalid,
    NoSuchRole,
    PortExhausted,
    ProtectedInstance,
    UnknownInstance,
)
from .model import (
    InstanceKind,
    InstanceState,
    LauncherRecord,
    Orphan,
    PortConflict,
    PortLease,
    ProcRef,
    Role,
    RoleStatus,
    Tier,
)

__all__ = [
    "InstanceError",
    "InstanceKind",
    "InstanceState",
    "KillFailed",
    "LauncherRecord",
    "NameInvalid",
    "NoSuchRole",
    "Orphan",
    "PortConflict",
    "PortExhausted",
    "PortLease",
    "ProcRef",
    "ProtectedInstance",
    "Role",
    "RoleStatus",
    "Tier",
    "UnknownInstance",
]
