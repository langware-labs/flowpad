"""Data model for instance management.

The launcher registry (``launcher.json``) is a **public contract** with roughly
a dozen independent readers — vitest harnesses under ``ui/tests/{hub,headless,
react,api,long_tests}``, ``scripts/run_hub_paired.sh``,
``scripts/phase11_cycle_report.py``, ``flow instance restart-backend`` — plus
four source-policy unit tests that pin the literal path expression. None of them
rejects unknown keys, so the schema may grow but may never rename or retype an
existing key. ``LauncherRecord.to_json`` therefore always emits the flat v1
mirror keys (``backend_pid``/``frontend_pid``/``backend_port``/``frontend_port``)
alongside the nested v2 form.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from enum import Enum, IntEnum

SCHEMA_VERSION = 2


class _StrEnum(str, Enum):
    """``enum.StrEnum`` semantics on the 3.10 floor this package supports.

    Members compare and serialize as their plain string value, so ``str(kind)``
    is ``"hub-ui"`` rather than ``"InstanceKind.HUB_UI"`` — which matters
    because these values are written straight into ``launcher.json``.
    """

    def __str__(self) -> str:
        return str(self.value)


class Role(_StrEnum):
    BACKEND = "backend"
    FRONTEND = "frontend"


class InstanceKind(_StrEnum):
    """What an instance is made of.

    ``HUB_UI`` is a vite dev server pointed straight at the hub with no local
    backend — the frontend never reads ``FLOW_INSTANCE``, so the only thing that
    makes such a process reapable is the env var we stamp on it anyway.
    """

    FULL = "full"
    HUB_UI = "hub-ui"
    BACKEND_ONLY = "backend-only"


ROLES: dict[InstanceKind, frozenset[Role]] = {
    InstanceKind.FULL: frozenset({Role.BACKEND, Role.FRONTEND}),
    InstanceKind.HUB_UI: frozenset({Role.FRONTEND}),
    InstanceKind.BACKEND_ONLY: frozenset({Role.BACKEND}),
}


class Tier(IntEnum):
    """How confident we are that a process belongs to an instance.

    Only ``>= LINEAGE`` is ever signalled. Port occupancy is deliberately not a
    tier at all (it lands at ``NONE``), and a matching ``--mode`` argv is
    ``CMDLINE`` — reporting evidence only. Treating either as ownership is
    precisely the defect that let ``kill tmpl-3`` terminate dev-2's frontend.
    """

    #: No evidence at all — including "only listens on a port we leased",
    #: which is exactly the inference that made the old `kill` dangerous.
    NONE = 0
    #: argv mentions the instance (`vite --mode <name>`). Enough to NAME an
    #: orphan in a report, never enough to signal it.
    CMDLINE = 1
    #: Descends from a verified owner.
    LINEAGE = 2
    #: This instance's own launcher.json or server.json vouches for the PID.
    RECORDED = 3
    #: FLOW_INSTANCE read straight from the process environment.
    ENV = 4


#: At or above this tier a process may be signalled; below it, only reported.
#: LINEAGE is the floor because a child of a verified owner (vite's esbuild
#: helper, a backend's PTY children) is as much ours as the parent, and nothing
#: else records those PIDs.
KILL_TIER = Tier.LINEAGE


class InstanceState(_StrEnum):
    """Lifecycle only.

    Port conflicts deliberately are NOT a state: they are a relationship
    between two instances, carried on ``InstanceStatus.conflicts`` and on the
    report. Modelling them here too meant one fact in two places, and the
    "only when not RUNNING" rule needed to reconcile them hid a conflict
    entirely whenever the instance was otherwise healthy.
    """

    UNKNOWN = "unknown"      # nothing on disk, nothing in the process table
    STALE = "stale"          # artifacts on disk, zero live owned processes
    ORPHANED = "orphaned"    # live owned processes, no launcher.json
    DEGRADED = "degraded"    # registry present, only some expected roles live
    RUNNING = "running"      # registry present, every role of its kind live


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


@dataclass(frozen=True)
class ProcRef:
    """A process this launcher spawned, identified strongly enough to survive
    PID recycling: ``create_time`` pins the identity, so a recycled PID cannot
    be adopted as ours and killed."""

    pid: int | None = None
    pgid: int | None = None
    create_time: float | None = None
    port: int | None = None
    log: str | None = None

    def to_json(self) -> dict:
        return {
            "pid": self.pid,
            "pgid": self.pgid,
            "create_time": self.create_time,
            "port": self.port,
            "log": self.log,
        }

    @classmethod
    def from_json(cls, d: dict | None) -> ProcRef:
        d = d or {}
        return cls(
            pid=int_or_none(d.get("pid")),
            pgid=int_or_none(d.get("pgid")),
            create_time=float_or_none(d.get("create_time")),
            port=int_or_none(d.get("port")),
            log=d.get("log"),
        )


@dataclass(frozen=True)
class LauncherRecord:
    """The contents of ``launcher.json``."""

    name: str
    group: str
    kind: InstanceKind = InstanceKind.FULL
    hub_url: str = ""
    email: str = ""
    env_file: str = ""
    repo_root: str = ""
    created_at: str = field(default_factory=utc_now_iso)
    backend: ProcRef = field(default_factory=ProcRef)
    frontend: ProcRef = field(default_factory=ProcRef)
    schema_version: int = SCHEMA_VERSION

    @property
    def roles(self) -> frozenset[Role]:
        return ROLES[self.kind]

    def ref(self, role: Role) -> ProcRef | None:
        """The ProcRef for ``role``, or None when the kind has no such role.

        Callers branch on ``roles``/this returning None rather than on
        ``kind ==``, so adding a kind never means auditing every call site.
        """
        if role not in self.roles:
            return None
        return self.backend if role is Role.BACKEND else self.frontend

    def with_ref(self, role: Role, ref: ProcRef) -> LauncherRecord:
        key = "backend" if role is Role.BACKEND else "frontend"
        return replace(self, **{key: ref})

    def to_json(self) -> dict:
        """Serialize, always including the flat v1 mirror keys.

        A hub-ui record deliberately writes ``backend_port: null`` and **omits
        ``backend_pid`` entirely** so that the desk-instance gates in
        ``ui/tests/hub/_instances.ts`` (which require an integer port and a live
        pid) reject it structurally. A hub-ui instance failing those checks is
        the intended behavior, not an accident to be papered over.
        """
        d: dict = {
            "schema_version": SCHEMA_VERSION,
            "name": self.name,
            "group": self.group,
            "kind": str(self.kind),
            "created_at": self.created_at,
            "repo_root": self.repo_root,
            "env_file": self.env_file,
            "hub_url": self.hub_url,
            "email": self.email,
            "backend": self.backend.to_json() if Role.BACKEND in self.roles else None,
            "frontend": self.frontend.to_json() if Role.FRONTEND in self.roles else None,
            # v1 mirrors — load-bearing for ~12 external readers.
            "backend_port": self.backend.port if Role.BACKEND in self.roles else None,
            "frontend_port": self.frontend.port if Role.FRONTEND in self.roles else None,
            "backend_log": self.backend.log,
            "frontend_log": self.frontend.log,
        }
        if Role.BACKEND in self.roles and self.backend.pid is not None:
            d["backend_pid"] = self.backend.pid
        if Role.FRONTEND in self.roles and self.frontend.pid is not None:
            d["frontend_pid"] = self.frontend.pid
        return d

    @classmethod
    def from_json(cls, d: dict) -> LauncherRecord:
        """Read v1 or v2. v1 files have no ``kind``/``group``; they are always
        full instances whose group is their own name."""
        name = d.get("name") or ""
        kind = _kind_or_default(d.get("kind"))
        roles = ROLES[kind]

        def _ref(nested_key: str, port_key: str, pid_key: str, log_key: str) -> ProcRef:
            nested = d.get(nested_key)
            if isinstance(nested, dict):
                ref = ProcRef.from_json(nested)
                # v2 nested form is authoritative, but fall back to the mirrors
                # for files written by a mixed-version tree.
                if ref.port is None:
                    ref = replace(ref, port=int_or_none(d.get(port_key)))
                if ref.pid is None:
                    ref = replace(ref, pid=int_or_none(d.get(pid_key)))
                if ref.log is None:
                    ref = replace(ref, log=d.get(log_key))
                return ref
            return ProcRef(
                pid=int_or_none(d.get(pid_key)),
                port=int_or_none(d.get(port_key)),
                log=d.get(log_key),
            )

        backend = _ref("backend", "backend_port", "backend_pid", "backend_log")
        frontend = _ref("frontend", "frontend_port", "frontend_pid", "frontend_log")
        return cls(
            name=name,
            group=d.get("group") or name,
            kind=kind,
            hub_url=d.get("hub_url") or "",
            email=d.get("email") or "",
            env_file=d.get("env_file") or "",
            repo_root=d.get("repo_root") or "",
            created_at=d.get("created_at") or "",
            backend=backend if Role.BACKEND in roles else ProcRef(),
            frontend=frontend if Role.FRONTEND in roles else ProcRef(),
            schema_version=int_or_none(d.get("schema_version")) or 1,
        )


@dataclass(frozen=True)
class PortLease:
    """One row of the port ledger. Keyed by port, because "one process owns a
    port" is the physical invariant the ledger exists to record."""

    port: int
    instance: str
    role: Role
    pid: int | None = None
    create_time: float | None = None
    acquired_at: str = field(default_factory=utc_now_iso)

    def to_json(self) -> dict:
        return {
            "instance": self.instance,
            "role": str(self.role),
            "pid": self.pid,
            "create_time": self.create_time,
            "acquired_at": self.acquired_at,
        }

    @classmethod
    def from_json(cls, port: int, d: dict) -> PortLease | None:
        inst = d.get("instance")
        role = d.get("role")
        if not inst or role not in (Role.BACKEND, Role.FRONTEND):
            return None
        return cls(
            port=port,
            instance=inst,
            role=Role(role),
            pid=int_or_none(d.get("pid")),
            create_time=float_or_none(d.get("create_time")),
            acquired_at=d.get("acquired_at") or "",
        )


@dataclass(frozen=True)
class PortConflict:
    port: int
    leased_to: str
    held_by: str | None
    pids: tuple[int, ...] = ()

    def to_json(self) -> dict:
        return {
            "port": self.port,
            "leased_to": self.leased_to,
            "held_by": self.held_by,
            "pids": list(self.pids),
        }


@dataclass(frozen=True)
class RoleStatus:
    """Rendered state of one role of one instance."""

    role: Role
    applicable: bool
    port: int | None = None
    pid: int | None = None
    alive: bool = False
    owned: bool = False
    tier: Tier = Tier.NONE
    listening: bool = False

    def to_json(self) -> dict:
        return {
            "applicable": self.applicable,
            "port": self.port,
            "pid": self.pid,
            "alive": self.alive,
            "owned": self.owned,
            "tier": self.tier.name.lower(),
            "listening": self.listening,
        }


@dataclass(frozen=True)
class Orphan:
    """A live, owned process whose instance has no launcher registry."""

    pid: int
    instance: str
    role: Role | None
    port: int | None
    create_time: float | None
    cmd: str

    @property
    def age_s(self) -> float | None:
        if self.create_time is None:
            return None
        return max(0.0, time.time() - self.create_time)

    def to_json(self) -> dict:
        return {
            "pid": self.pid,
            "instance": self.instance,
            "role": str(self.role) if self.role else None,
            "port": self.port,
            "age_s": None if self.age_s is None else round(self.age_s),
            "cmd": self.cmd,
        }


@dataclass(frozen=True)
class InstanceStatus:
    """One instance as rendered by ``status``/``list``."""

    name: str
    group: str
    kind: InstanceKind
    state: InstanceState
    backend: RoleStatus
    frontend: RoleStatus
    hub_url: str = ""
    email: str = ""
    created_at: str = ""
    age_s: float | None = None
    #: Was this instance created by the launcher? False for `oss`/`prod`, which
    #: are started by hand and never get a launcher.json. A first-class field
    #: rather than a warning substring: `kill`, `reset` and group teardown all
    #: need the predicate, and matching prose for it is fragile in both
    #: directions.
    launcher_owned: bool = True
    conflicts: tuple[PortConflict, ...] = ()
    warnings: tuple[str, ...] = ()

    @property
    def registered(self) -> bool:
        return self.state not in (InstanceState.UNKNOWN, InstanceState.ORPHANED)

    def role(self, role: Role) -> RoleStatus:
        return self.backend if role is Role.BACKEND else self.frontend

    def to_json(self) -> dict:
        return {
            "name": self.name,
            "group": self.group,
            "kind": str(self.kind),
            "state": str(self.state),
            "created_at": self.created_at,
            "age_s": None if self.age_s is None else round(self.age_s),
            "hub_url": self.hub_url,
            "email": self.email,
            "launcher_owned": self.launcher_owned,
            "backend": self.backend.to_json(),
            "frontend": self.frontend.to_json(),
            "conflicts": [c.to_json() for c in self.conflicts],
            "warnings": list(self.warnings),
        }


@dataclass(frozen=True)
class StatusReport:
    """Everything ``status`` knows, in one snapshot.

    Orphans and conflicts are report-level rather than per-instance because
    both are *relationships* between an instance and the machine — an orphan
    has no instance row to hang off, and a conflict by definition involves two.
    Surfacing them separately is what makes the failure that motivated this
    refactor visible instead of silently absorbed.
    """

    instances: tuple[InstanceStatus, ...] = ()
    orphans: tuple[Orphan, ...] = ()
    conflicts: tuple[PortConflict, ...] = ()
    protected: frozenset[str] = frozenset()
    ports_degraded: bool = False
    flow_home: str = ""
    repo_root: str = ""
    generated_at: str = field(default_factory=utc_now_iso)
    #: Instances withheld because they are stale/unknown and ``--all`` was off.
    hidden: int = 0

    def groups(self) -> dict[str, list[InstanceStatus]]:
        """Multi-member groups only.

        A group of one is just an instance; giving it a titled section of its
        own turns a machine with 250 leftovers into 250 headers and buries the
        three rows anyone cares about. Singletons render in one flat table —
        see ``ungrouped``.
        """
        out: dict[str, list[InstanceStatus]] = {}
        for inst in self.instances:
            out.setdefault(inst.group or inst.name, []).append(inst)
        for bucket in out.values():
            bucket.sort(key=lambda i: i.name)
        return {k: v for k, v in sorted(out.items()) if len(v) > 1}

    def ungrouped(self) -> list[InstanceStatus]:
        """Instances that are the only member of their group."""
        grouped = {i.name for members in self.groups().values() for i in members}
        return sorted(
            (i for i in self.instances if i.name not in grouped),
            key=lambda i: i.name,
        )

    @property
    def up(self) -> int:
        return sum(1 for i in self.instances if i.state is InstanceState.RUNNING)

    def to_json(self) -> dict:
        return {
            "schema_version": 1,
            "generated_at": self.generated_at,
            "flow_home": self.flow_home,
            "repo_root": self.repo_root,
            "protected": sorted(self.protected),
            "ports_degraded": self.ports_degraded,
            "hidden": self.hidden,
            "groups": [
                {
                    "name": name,
                    "members": [i.name for i in members],
                    "kinds": sorted({str(i.kind) for i in members}),
                    "up": sum(1 for i in members if i.state is InstanceState.RUNNING),
                    "total": len(members),
                }
                for name, members in self.groups().items()
            ],
            "instances": [i.to_json() for i in self.instances],
            "orphans": [o.to_json() for o in self.orphans],
            "port_conflicts": [c.to_json() for c in self.conflicts],
        }


def int_or_none(v) -> int | None:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def float_or_none(v) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _kind_or_default(v) -> InstanceKind:
    try:
        return InstanceKind(v)
    except ValueError:
        return InstanceKind.FULL
