"""Make on-disk state agree with the machine.

The launcher this replaces had no such step, and the drift was the whole
problem: 286 instance directories against 36 registries, 27 ``server.json``
files pointing at dead PIDs, 268 stale singleton locks, and nine frontend
processes that no command could name. Every command here begins by reconciling,
so the drift is bounded by one invocation rather than by months.

Reconciliation never destroys data. It clears *control-plane* facts that are
provably false — a recorded PID that is not alive, a ``server.json`` naming a
dead backend, a lease nothing holds. Databases, sodot and keychain entries are
not its business.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from . import liveness, paths, registry
from .liveness import ProcTable
from .model import Role, int_or_none
from .ports import PortLedger


@dataclass
class ReconcileReport:
    cleared_pids: list[str] = field(default_factory=list)
    removed_server_json: list[str] = field(default_factory=list)
    removed_locks: list[str] = field(default_factory=list)
    dropped_leases: list[int] = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return bool(
            self.cleared_pids or self.removed_server_json
            or self.removed_locks or self.dropped_leases
        )

    def to_json(self) -> dict:
        return {
            "cleared_pids": self.cleared_pids,
            "removed_server_json": self.removed_server_json,
            "removed_locks": self.removed_locks,
            "dropped_leases": sorted(self.dropped_leases),
            "changed": self.changed,
        }


def reconcile(
    names: list[str] | None = None,
    *,
    table: ProcTable | None = None,
    dry_run: bool = False,
) -> ReconcileReport:
    """Clear control-plane state that no longer describes anything.

    Idempotent, and safe to run at the top of any command.
    """
    table = table if table is not None else liveness.scan()
    report = ReconcileReport()
    targets = names or sorted(registry.all_known_names())

    for name in targets:
        _reconcile_one(name, table, report, dry_run)

    if dry_run:
        report.dropped_leases = PortLedger.load().reconcile(table)
    else:
        with PortLedger.open() as ledger:
            report.dropped_leases = ledger.reconcile(table)
    return report


def _reconcile_one(
    name: str, table: ProcTable, report: ReconcileReport, dry_run: bool
) -> None:
    rec = registry.read(name)
    if rec is not None:
        cleared = False
        for role in (Role.BACKEND, Role.FRONTEND):
            ref = rec.ref(role)
            if ref is None or ref.pid is None:
                continue
            table.adopt_recorded(name, ref.pid, ref.create_time)
            if table.is_owned_by(ref.pid, name):
                continue
            # The PID is dead or now belongs to someone else. Keep the PORT —
            # the lease is what makes a relaunch land back on the same port —
            # but stop asserting a process that isn't there.
            report.cleared_pids.append(f"{name}/{role} pid {ref.pid}")
            rec = rec.with_ref(role, ref.__class__(port=ref.port, log=ref.log))
            cleared = True
        if cleared and not dry_run:
            registry.write(rec)

    _reconcile_server_json(name, table, report, dry_run)
    _reconcile_singleton_lock(name, table, report, dry_run)


def _reconcile_server_json(
    name: str, table: ProcTable, report: ReconcileReport, dry_run: bool
) -> None:
    """Delete a ``server.json`` whose backend is gone.

    ``clear_server_info`` only runs on a graceful uvicorn shutdown, so a
    SIGKILL, a crash or a closed laptop leaves the file behind. That is not
    cosmetic: ``flow hooks report`` POSTs to every ``server.json`` it finds, so
    a stale file whose port has since been recycled delivers another instance's
    hook payloads into a live, unrelated backend.
    """
    path = paths.server_json_path(name)
    if not path.exists():
        return
    server = registry.read_server_info(name)
    pid, port = int_or_none(server.get("server_pid")), int_or_none(server.get("port"))
    if pid is not None and table.adopt_server_json(name, pid, port):
        return
    report.removed_server_json.append(name)
    if not dry_run:
        path.unlink(missing_ok=True)


def _reconcile_singleton_lock(
    name: str, table: ProcTable, report: ReconcileReport, dry_run: bool
) -> None:
    """Remove ``server.lock``/``server.pid`` left by an exited backend.

    ``run.py`` releases the lock on a clean exit but never unlinks the files, so
    every instance that ever ran keeps a pair forever — 268 of them on the
    machine that motivated this. They are harmless individually and misleading
    in bulk, since their presence reads as "a backend lives here".
    """
    lock, pidfile = paths.server_lock_path(name), paths.server_pid_path(name)
    if not lock.exists() and not pidfile.exists():
        return
    try:
        pid = int(pidfile.read_text().strip())
    except (OSError, ValueError):
        pid = None
    if pid is not None and table.owner_of(pid) is not None:
        return  # a live process still holds it
    report.removed_locks.append(name)
    if not dry_run:
        lock.unlink(missing_ok=True)
        pidfile.unlink(missing_ok=True)


