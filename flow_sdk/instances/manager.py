"""Orchestration: one function per CLI verb. No typer, no printing.

Keeping rendering out of here is what lets ``status`` serve a human table, a
``--json`` document, and an exit-code predicate from a single code path — the
three consumers can never disagree about whether an instance is up.

**Read paths only, for now.** ``launch``/``kill``/``reap``/``reset`` land in
later steps; until then ``scripts/instance_ctl.sh`` still owns them.
"""

from __future__ import annotations

import time
from datetime import datetime

from . import env, liveness, paths, procs, registry
from .errors import NoSuchRole, ProtectedInstance, UnknownInstance
from .liveness import ProcTable
from .model import (
    int_or_none,
    InstanceKind,
    PortConflict,
    InstanceState,
    InstanceStatus,
    LauncherRecord,
    Orphan,
    Role,
    RoleStatus,
    StatusReport,
    Tier,
)
from .ports import PortLedger


#: States withheld from the default view: leftovers, not running services.
_QUIESCENT = (InstanceState.STALE, InstanceState.UNKNOWN)


def status(
    names: list[str] | None = None,
    *,
    group: str | None = None,
    all_: bool = False,
) -> StatusReport:
    """Snapshot every requested instance against one process-table scan.

    A single shared scan is not just a speed-up: it is what makes two rows of
    the same table unable to disagree about whether a PID is alive.

    With no explicit names, stale and never-allocated instances are withheld and
    counted in ``hidden``. The default question is "what is running on this
    machine", and on a real one the leftovers outnumber the live instances
    roughly eighty to one — a listing that buries three live rows under 250 dead
    ones answers nobody. ``all_=True`` shows everything; an explicitly named
    instance is always shown, whatever its state.
    """
    table = liveness.scan()
    ledger = PortLedger.load()

    explicit = bool(names)
    if names:
        targets = [paths.validate_name(n) for n in names]
    else:
        targets = sorted(_all_candidate_names(table, ledger))

    records = {r.name: r for r in registry.all_records()}
    # Orphan detection is computed over the WHOLE machine, never over the
    # displayed subset: `status dev-1` must not report another instance's
    # healthy workers as garbage just because that instance was filtered out.
    accounted = _accounted_names(table, records)
    # Computed ONCE and bucketed. This used to run inside `_resolve`, i.e. once
    # per instance: each pass is O(leases x processes), so on a machine with a
    # few hundred instances and a populated ledger it was millions of redundant
    # comparisons — and two independent computations of one fact that could
    # disagree between an instance's row and the report's footer.
    all_conflicts = ledger.conflicts(table)
    by_lease: dict[str, list] = {}
    for c in all_conflicts:
        by_lease.setdefault(c.leased_to, []).append(c)

    instances = [
        _resolve(
            name, records.get(name), table, ledger,
            tuple(by_lease.get(name, ())),
        )
        for name in targets
    ]
    if group is not None:
        instances = [i for i in instances if i.group == group]

    hidden = 0
    if not explicit and not all_:
        # A conflicted instance stays visible whatever its lifecycle state:
        # "another instance took your port" is actionable, and hiding it was a
        # gap opened by making conflict a relationship rather than a state.
        keep = [
            i for i in instances
            if i.state not in _QUIESCENT or i.conflicts
        ]
        hidden = len(instances) - len(keep)
        instances = keep

    return StatusReport(
        instances=tuple(instances),
        hidden=hidden,
        orphans=tuple(_orphans(table, accounted)),
        conflicts=tuple(all_conflicts),
        protected=paths.protected_instances(),
        ports_degraded=table.ports_degraded,
        flow_home=str(paths.flow_home()),
        repo_root=str(paths.repo_root()),
    )


def resolve(name: str) -> InstanceStatus:
    """Status of a single instance. Never raises for an unknown name — the
    caller gets an ``UNKNOWN`` row, which is a fact, not an error."""
    paths.validate_name(name)
    table = liveness.scan()
    ledger = PortLedger.load()
    conflicts = tuple(c for c in ledger.conflicts(table) if c.leased_to == name)
    return _resolve(name, registry.read(name), table, ledger, conflicts)


def is_up(name: str, role: Role | None = None) -> bool:
    """True iff the instance is registered and every expected role is live AND
    ownership-verified.

    An orphan is deliberately *not* "up": it has live processes but no verified
    control record, so nothing can be safely concluded about it — which is
    precisely the state the old port-occupancy check reported as ``[UP]``.
    """
    st = resolve(name)
    if not st.registered:
        return False
    if role is not None:
        rs = st.role(role)
        return rs.applicable and rs.alive and rs.owned
    return st.state is InstanceState.RUNNING


def port_of(name: str, role: Role) -> int:
    """The live port for ``name``'s ``role``.

    Raises rather than returning a guess: a caller doing ``PORT=$(… port x)``
    must get an empty variable and a non-zero status, never a stale port that
    silently points at someone else's backend.
    """
    st = resolve(name)
    if st.state is InstanceState.UNKNOWN:
        raise UnknownInstance(f"instance '{name}' is not allocated")
    rs = st.role(role)
    if not rs.applicable:
        raise NoSuchRole(f"instance '{name}' is kind={st.kind} and has no {role}")
    if rs.port is None or not (rs.alive and rs.owned):
        raise UnknownInstance(f"instance '{name}' has no live {role}")
    return rs.port


# ── internals ────────────────────────────────────────────────────────────────
def _all_candidate_names(table: ProcTable, ledger: PortLedger) -> set[str]:
    """Every name worth showing: on-disk footprint, lease, or live process."""
    names = registry.all_known_names()
    names |= {ls.instance for ls in ledger.leases.values()}
    names |= table.instances()
    return {n for n in names if _is_valid(n)}


def _is_valid(name: str) -> bool:
    from .errors import NameInvalid

    try:
        paths.validate_name(name)
    except NameInvalid:
        return False
    return True


def _resolve(
    name: str,
    rec: LauncherRecord | None,
    table: ProcTable,
    ledger: PortLedger,
    conflicts: tuple[PortConflict, ...] = (),
) -> InstanceStatus:
    warnings: list[str] = []
    server = _adopt_server_json(name, table)

    if rec is None:
        return _resolve_unregistered(
            name, table, ledger, server, warnings, conflicts
        )

    # A registry's own PIDs are adopted before anything is decided, so a process
    # whose environ we cannot read still resolves as ours — but only for the
    # instance that recorded it, and only when create_time agrees.
    for role in (Role.BACKEND, Role.FRONTEND):
        ref = rec.ref(role)
        if ref is not None:
            table.adopt_recorded(name, ref.pid, ref.create_time)

    roles = {
        role: _role_status(name, rec, role, table)
        for role in (Role.BACKEND, Role.FRONTEND)
    }
    applicable = [rs for rs in roles.values() if rs.applicable]
    live = [rs for rs in applicable if rs.alive and rs.owned]

    if not applicable:
        state = InstanceState.STALE
    elif len(live) == len(applicable):
        state = InstanceState.RUNNING
    elif live:
        state = InstanceState.DEGRADED
    else:
        state = InstanceState.STALE

    for rs in applicable:
        if rs.alive and not rs.owned:
            warnings.append(
                f"{rs.role} pid {rs.pid} is alive but not owned by '{name}' "
                "— not a kill target"
            )

    stolen = [c for c in conflicts if c.held_by != name]
    for c in stolen:
        warnings.append(
            f"port {c.port} leased to '{name}' is held by "
            f"'{c.held_by or 'an unattributable process'}'"
        )

    if state is InstanceState.STALE and rec.kind is not InstanceKind.HUB_UI:
        warnings.append("no live owned processes — reap or relaunch")

    return InstanceStatus(
        name=name,
        group=rec.group or name,
        kind=rec.kind,
        state=state,
        backend=roles[Role.BACKEND],
        frontend=roles[Role.FRONTEND],
        hub_url=rec.hub_url,
        email=rec.email,
        created_at=rec.created_at,
        age_s=_age_of(rec, table, name),
        launcher_owned=True,
        conflicts=conflicts,
        warnings=tuple(warnings),
    )


def _accounted_names(table: ProcTable, records: dict) -> set[str]:
    """Instances that something legitimately vouches for.

    Two sources: a launcher registry, or a ``server.json`` whose recorded PID is
    a live backend. The second is what keeps a hand-started ``oss``/``prod`` —
    and every claude/PTY worker beneath it — out of the reap list.
    """
    accounted = set(records)
    for d in paths.known_instance_dirs():
        name = d.name
        if name in accounted:
            continue
        server = registry.read_server_info(name)
        if not server:
            continue
        if table.adopt_server_json(
            name, int_or_none(server.get("server_pid")), int_or_none(server.get("port"))
        ):
            accounted.add(name)
    return accounted


def _adopt_server_json(name: str, table: ProcTable) -> dict:
    """Let a backend's own ``server.json`` vouch for its PID. Returns the file."""
    server = registry.read_server_info(name)
    if server:
        table.adopt_server_json(
            name, int_or_none(server.get("server_pid")), int_or_none(server.get("port"))
        )
    return server


def _resolve_unregistered(
    name: str,
    table: ProcTable,
    ledger: PortLedger,
    server: dict,
    warnings: list[str],
    conflicts: tuple[PortConflict, ...] = (),
) -> InstanceStatus:
    """An instance with no ``launcher.json``.

    Not every such instance is broken. ``oss`` and ``prod`` are started by hand
    and never get a launcher registry, so a live backend vouched for by its own
    ``server.json`` is simply RUNNING — reporting it as an orphan to be reaped
    would invite killing a developer's working backend and every worker under
    it.

    Ports and PIDs come from the process table, never from the ledger: a lease
    records intent, and presenting intent as a running service is the exact lie
    this refactor removes.
    """
    owned = table.owned_by(name)

    def _discovered(role: Role) -> RoleStatus:
        procs = [p for p in owned if p.role is role]
        if not procs:
            return RoleStatus(role=role, applicable=bool(owned))
        proc = procs[0]
        port = next(iter(sorted(proc.listen_ports)), None)
        if port is None and role is Role.BACKEND:
            port = int_or_none(server.get("port"))
        return RoleStatus(
            role=role, applicable=True, port=port, pid=proc.pid,
            alive=True, owned=True, tier=proc.tier, listening=port is not None,
        )

    backend, frontend = _discovered(Role.BACKEND), _discovered(Role.FRONTEND)

    if backend.alive and backend.owned:
        # Self-managed: its backend is live and vouched for by its own record.
        state = InstanceState.RUNNING
    elif owned:
        state = InstanceState.ORPHANED
        warnings.append("no launcher.json — run 'reap' or 'kill' to clean up")
    elif _has_footprint(name, ledger):
        state = InstanceState.STALE
        warnings.append("leftover files with no live process — run 'reset'")
    else:
        state = InstanceState.UNKNOWN
        warnings.append("never allocated")

    if server and not (backend.alive and backend.owned):
        warnings.append(
            f"stale server.json (pid {server.get('server_pid')} is not a live "
            "owned backend) — a hook broadcast target that no longer exists"
        )

    ages = [p.create_time for p in owned if p.create_time]
    return InstanceStatus(
        name=name,
        group=name,
        kind=InstanceKind.FULL,
        state=state,
        backend=backend,
        frontend=frontend,
        age_s=(time.time() - min(ages)) if ages else None,
        launcher_owned=False,
        conflicts=conflicts,
        warnings=tuple(warnings),
    )




def _role_status(
    name: str, rec: LauncherRecord, role: Role, table: ProcTable
) -> RoleStatus:
    ref = rec.ref(role)
    if ref is None:
        # Not "down" — this kind simply has no such role. A hub-ui instance
        # with no backend must not read as half-broken.
        return RoleStatus(role=role, applicable=False)

    pid, proc = ref.pid, None
    if pid is not None:
        candidate = table.owner_of(pid)
        if candidate is not None and table.is_owned_by(pid, name):
            proc = candidate

    # The recorded PID may be stale after an out-of-band restart; fall back to
    # any owned process of this instance that is actually serving the port.
    if proc is None and ref.port is not None:
        serving = [p for p in table.listeners(ref.port) if p.instance == name and p.killable]
        if serving:
            proc, pid = serving[0], serving[0].pid

    alive_unowned = (
        proc is None and ref.pid is not None and table.owner_of(ref.pid) is not None
    )
    return RoleStatus(
        role=role,
        applicable=True,
        port=ref.port,
        pid=ref.pid if proc is None else proc.pid,
        alive=proc is not None or alive_unowned,
        owned=proc is not None,
        tier=proc.tier if proc is not None else Tier.NONE,
        listening=bool(proc and ref.port and ref.port in proc.listen_ports),
    )


def _orphans(table: ProcTable, accounted: set[str]) -> list[Orphan]:
    """Live owned processes belonging to instances nothing accounts for.

    This is the population the bash launcher could not even name, let alone
    kill: ``gc`` deleted registries without touching processes, and ``kill``
    needed a registry to find its ports, so a swept instance's frontend ran
    forever.

    ``accounted`` covers both launcher-registered instances and self-managed
    ones with a live backend — a developer's hand-started ``oss`` and the claude
    workers beneath it are not garbage.
    """
    out: list[Orphan] = []
    for proc in table.procs.values():
        if proc.instance is None or proc.tier < Tier.LINEAGE:
            continue
        if proc.instance in accounted:
            continue
        out.append(
            Orphan(
                pid=proc.pid,
                instance=proc.instance,
                role=proc.role,
                port=next(iter(sorted(proc.listen_ports)), None),
                create_time=proc.create_time,
                cmd=proc.cmd[:200],
            )
        )
    return sorted(out, key=lambda o: (o.instance, o.pid))


def _has_footprint(name: str, ledger: PortLedger) -> bool:
    return bool(
        paths.instance_dir(name).exists()
        or paths.env_file(name).exists()
        or ledger.leases_of(name)
    )


def _age_of(rec: LauncherRecord, table: ProcTable, name: str) -> float | None:
    if rec.created_at:
        try:
            born = datetime.fromisoformat(rec.created_at.replace("Z", "+00:00"))
            return max(0.0, time.time() - born.timestamp())
        except ValueError:
            pass
    ages = [p.create_time for p in table.owned_by(name) if p.create_time]
    return (time.time() - min(ages)) if ages else None


# ── healing ──────────────────────────────────────────────────────────────────
def reap(
    *,
    dry_run: bool = False,
    include_protected: bool = False,
    only: set[str] | None = None,
) -> dict:
    """Kill live processes belonging to instances nothing accounts for.

    ``only`` restricts the sweep to named instances. It exists because the
    process table is machine-global and cannot be redirected the way
    ``FLOW_HOME`` can: a caller working against a throwaway instance root would
    otherwise see every real instance on the box as unaccounted-for and reap it.
    Tests must always pass it.

    This population is the direct product of the bash launcher's two halves not
    meeting: ``gc`` deleted registries without touching processes, and ``kill``
    needed a registry to find its ports — so a swept instance's frontend became
    both invisible and unkillable. Nine of them were running on the machine that
    motivated this, the oldest four days.

    Protected instances are never reaped without ``include_protected``, and an
    instance whose own ``server.json`` vouches for a live backend is not an
    orphan at all — reaping a developer's hand-started ``oss`` and every claude
    worker under it would be a far worse bug than the one being fixed.
    """
    _require_scope_or_real_root(only, "reap")

    table = liveness.scan()
    records = {r.name: r for r in registry.all_records()}
    accounted = _accounted_names(table, records)
    protected = paths.protected_instances()

    all_orphans = _orphans(table, accounted)
    orphans = all_orphans
    if not include_protected:
        orphans = [o for o in orphans if o.instance not in protected]
    if only is not None:
        orphans = [o for o in orphans if o.instance in only]
        all_orphans = [o for o in all_orphans if o.instance in only]

    by_instance: dict[str, list] = {}
    for o in orphans:
        by_instance.setdefault(o.instance, []).append(o)

    killed, survivors, refused = [], [], []
    if not dry_run:
        for name in sorted(by_instance):
            res = procs.kill_owned(name, table)
            killed.extend(res.killed)
            survivors.extend(res.survivors)
            refused.extend(res.refused)

    return {
        "dry_run": dry_run,
        "instances": sorted(by_instance),
        "orphans": [o.to_json() for o in orphans],
        "killed": sorted(killed),
        "survivors": sorted(survivors),
        "refused": refused,
        "skipped_protected": [] if include_protected else sorted(
            {o.instance for o in all_orphans} & protected
        ),
    }


def _require_scope_or_real_root(only: set[str] | None, verb: str) -> None:
    """Refuse a machine-wide sweep when the instance root has been redirected.

    The asymmetry that makes this necessary: on-disk state follows ``FLOW_HOME``,
    but the process table is global and cannot be redirected. So a caller
    pointed at a throwaway instance root sees an empty registry, concludes that
    every real instance on the machine is unaccounted-for, and kills all of
    them. That is not hypothetical — it took out five live dev servers during
    this refactor.

    Failing closed here makes the mistake structurally impossible, rather than
    depending on every caller remembering to pass ``only``.
    """
    if only is not None:
        return
    from pathlib import Path

    real = Path.home() / ".flow" / "instances"
    if paths.instances_root().resolve() != real.resolve():
        raise ProtectedInstance(
            f"refusing an unscoped {verb}: instance root is "
            f"{paths.instances_root()}, not {real}. A redirected root cannot "
            "see which of the machine's live processes are legitimate, so a "
            "machine-wide sweep from here would kill them. Pass only={...}."
        )


def gc(*, age_days: int = 14, dry_run: bool = False,
       include_protected: bool = False, only: set[str] | None = None) -> dict:
    """Delete the DATA DIRECTORY of instances that are dead and abandoned.

    Deliberately narrower than the bash ``gc`` it replaces, which conflated two
    jobs and did neither well. That one ANDed a ``find -mtime`` window into its
    liveness test, which is the wrong signal — a database or a log gets touched
    by any passing reader, so instances stayed "recent" forever and 250 of them
    accumulated. Here **liveness gates process reaping and age gates only data
    destruction**, which is the one decision an mtime is actually evidence for.

    ``reap`` runs first, so this can never delete the directory of a still-running
    orphan — the bash version could, which is how a process ended up with no
    registry and no way to name it.
    """
    _require_scope_or_real_root(only, "gc")

    reaped = reap(dry_run=dry_run, include_protected=include_protected, only=only)
    # One snapshot for the whole command. This used to scan the process table,
    # read every launcher.json and recompute `accounted` a second time right
    # after `reap` had already done all three — about half of gc's runtime.
    # Re-scanning after the kills would not make the decision safer either,
    # since the `table.owned_by` check below already skips anything still live.
    table = liveness.scan()
    records = {r.name: r for r in registry.all_records()}
    accounted = _accounted_names(table, records)
    protected = paths.protected_instances()
    cutoff = time.time() - age_days * 86400

    removed = []
    for d in paths.known_instance_dirs():
        name = d.name
        if only is not None and name not in only:
            continue
        if name in records or name in accounted:
            continue
        if not include_protected and name in protected:
            continue
        if table.owned_by(name):
            continue
        if _newest_mtime(d) > cutoff:
            continue
        removed.append(name)
        if not dry_run:
            from flow_sdk.claude_env import _rmtree_safe

            _rmtree_safe(d)

    return {
        "dry_run": dry_run,
        "age_days": age_days,
        "reaped": reaped,
        "removed_dirs": sorted(removed),
    }


def _newest_mtime(d) -> float:
    """Most recent activity in an instance dir — from one directory level only.

    Deliberately not ``rglob("*")``. An instance data dir holds a SQLite tree,
    ``records/`` and rotated logs: 389,648 entries across 40 dirs on a real
    machine, which made a full walk of all 286 take ~80 seconds and left
    ``gc --dry-run`` looking hung. One ``scandir`` level over all 286 takes
    0.31s.

    The shallow signal is sufficient because a directory's own mtime moves
    whenever entries are added or removed, and everything that marks an
    instance as recently used — the DB, ``launcher.json``, ``server.json``, the
    launcher logs — is a direct child.
    """
    import os as _os

    newest = 0.0
    try:
        newest = d.stat().st_mtime
    except OSError:
        return 0.0
    try:
        with _os.scandir(d) as it:
            for entry in it:
                try:
                    newest = max(newest, entry.stat(follow_symlinks=False).st_mtime)
                except OSError:
                    continue
    except OSError:
        pass
    return newest


__all__ = [
    "status", "resolve", "is_up", "port_of", "reap", "gc", "env",
]
