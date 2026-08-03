"""The port ledger: who owns which port, and who may kill what.

The bash launcher derived a preferred port from an instance name's trailing
digits and scanned upward for anything not currently listening. Nothing was ever
recorded, so two facts collided: ``name_index`` falls back to ``1`` for any name
without trailing digits (``qa-cycle``, ``oss``, ``gitconn`` all preferred 6001),
and "free" was decided by a momentary ``lsof``. The result on a real machine was
three registries claiming backend 6001 and three more claiming frontend 5007 —
and since ``kill`` terminated whatever listened on its *recorded* port,
``kill tmpl-3`` would SIGTERM dev-2's frontend.

This module fixes that with two mechanisms:

* a persisted lease table, so allocation knows what it already handed out; and
* ``kill_allowed``, which refuses to signal a port unless every listener on it
  is ownership-verified as belonging to the target instance.

A lease whose port has been taken by a stranger is deliberately **not** dropped
silently — it surfaces as a ``PortConflict`` so the collision is visible instead
of acted upon.
"""

from __future__ import annotations

import re
from contextlib import contextmanager
from itertools import chain
from dataclasses import dataclass, field
from typing import Iterator

from . import paths
from .atomic import locked, read_json, write_json_atomic
from .errors import PortExhausted
from .liveness import ProcTable
from .model import PortConflict, PortLease, Role, utc_now_iso

LEDGER_SCHEMA_VERSION = 1

FRONTEND_BASE = 5000
BACKEND_BASE = 6000
BAND_SPAN = 99

#: Ports we never hand out even when nothing is listening, because something
#: else owns them by convention:
#:   5000 — macOS AirPlay Receiver
#:   5001 — neo4j (used by the hub's graph store on this machine)
#:   6000 — browsers refuse it as ERR_UNSAFE_PORT
RESERVED_PORTS: dict[int, str] = {
    5000: "macOS AirPlay",
    5001: "neo4j",
    6000: "ERR_UNSAFE_PORT",
}

_TRAILING_DIGITS = re.compile(r"(\d+)$")


def name_index(name: str) -> int:
    """``dev-1`` → 1. Names without trailing digits get 1, matching the bash
    launcher's behavior — the ledger, not the preference, is what keeps them
    from colliding."""
    m = _TRAILING_DIGITS.search(name)
    return int(m.group(1)) if m else 1


def base_for(role: Role) -> int:
    return BACKEND_BASE if role is Role.BACKEND else FRONTEND_BASE


def preferred_port(name: str, role: Role) -> int:
    return base_for(role) + name_index(name)


@dataclass
class PortLedger:
    leases: dict[int, PortLease] = field(default_factory=dict)

    # ── persistence ──────────────────────────────────────────────────────────
    @classmethod
    def load(cls) -> PortLedger:
        raw = read_json(paths.ports_ledger_path())
        leases: dict[int, PortLease] = {}
        for key, val in (raw.get("leases") or {}).items():
            try:
                port = int(key)
            except (TypeError, ValueError):
                continue
            if not isinstance(val, dict):
                continue
            lease = PortLease.from_json(port, val)
            if lease is not None:
                leases[port] = lease
        return cls(leases=leases)

    def save(self) -> None:
        write_json_atomic(
            paths.ports_ledger_path(),
            {
                "schema_version": LEDGER_SCHEMA_VERSION,
                "leases": {
                    str(port): lease.to_json()
                    for port, lease in sorted(self.leases.items())
                },
            },
        )

    @classmethod
    @contextmanager
    def open(cls) -> Iterator[PortLedger]:
        """Hold the ledger lock for a read-modify-write cycle."""
        with locked(paths.ports_ledger_lock()):
            ledger = cls.load()
            yield ledger
            ledger.save()

    # ── queries ──────────────────────────────────────────────────────────────
    def lease_for(self, name: str, role: Role) -> PortLease | None:
        for lease in self.leases.values():
            if lease.instance == name and lease.role is role:
                return lease
        return None

    def leases_of(self, name: str) -> list[PortLease]:
        return [ls for ls in self.leases.values() if ls.instance == name]

    def ports_of(self, name: str) -> set[int]:
        return {ls.port for ls in self.leases_of(name)}

    # ── mutation ─────────────────────────────────────────────────────────────
    def release(self, name: str, role: Role | None = None) -> list[int]:
        dropped = [
            port for port, ls in self.leases.items()
            if ls.instance == name and (role is None or ls.role is role)
        ]
        for port in dropped:
            del self.leases[port]
        return sorted(dropped)

    def record(
        self,
        port: int,
        name: str,
        role: Role,
        *,
        pid: int | None = None,
        create_time: float | None = None,
    ) -> PortLease:
        lease = PortLease(
            port=port,
            instance=name,
            role=role,
            pid=pid,
            create_time=create_time,
            acquired_at=utc_now_iso(),
        )
        # An instance holds at most one port per role; re-recording moves it.
        for stale in [p for p, ls in self.leases.items()
                      if ls.instance == name and ls.role is role and p != port]:
            del self.leases[stale]
        self.leases[port] = lease
        return lease

    def reconcile(self, table: ProcTable) -> list[int]:
        """Drop leases that no longer describe anything. Returns dropped ports.

        A lease survives while its holder shows any sign of life — a listener it
        owns, or any live owned process at all (a backend that is still booting
        holds no socket yet, and dropping its lease mid-launch would hand its
        port to the next allocator).

        A lease whose port is held by a *stranger* is kept, not dropped: that is
        a conflict to report (``conflicts()``), not a fact to silently accept.
        """
        dropped: list[int] = []
        for port, lease in sorted(self.leases.items()):
            listeners = table.listeners(port)
            if any(p.instance == lease.instance and p.killable for p in listeners):
                continue
            if table.owned_by(lease.instance):
                continue
            if listeners:
                continue  # stranger holds it → surfaced by conflicts()
            dropped.append(port)
        for port in dropped:
            del self.leases[port]
        return dropped

    def conflicts(self, table: ProcTable) -> list[PortConflict]:
        """Leases whose port is held by a process that is not the leaseholder's."""
        out: list[PortConflict] = []
        for port, lease in sorted(self.leases.items()):
            listeners = table.listeners(port)
            if not listeners:
                continue
            if all(p.instance == lease.instance and p.killable for p in listeners):
                continue
            out.append(
                PortConflict(
                    port=port,
                    leased_to=lease.instance,
                    held_by=table.port_owner(port),
                    pids=tuple(sorted(p.pid for p in listeners)),
                )
            )
        return out

    # ── allocation ───────────────────────────────────────────────────────────
    def allocate(self, name: str, role: Role, table: ProcTable) -> int:
        """Return the port ``name`` should use for ``role``, reserving it.

        **Sticky reuse comes first.** If this instance already holds a lease for
        the role and the port is either free or held only by its own processes,
        the same port comes back. Relaunch port-stability is a correctness
        requirement, not a convenience: ``pty_survives_restart`` and
        ``agentic_survives_restart`` read ``LOCAL_SERVER_PORT`` *before*
        relaunching and keep using it afterwards, so a port that moves during a
        restart makes those tests talk to nothing until they time out.
        """
        existing = self.lease_for(name, role)
        if existing is not None and self._is_reusable(existing.port, name, table):
            return existing.port

        base = base_for(role)
        pref = preferred_port(name, role)
        # Scan from the preferred port to the top of the band, then wrap to the
        # bottom — a high preferred index must not strand an instance while low
        # ports sit unused.
        candidates = chain(range(pref, base + BAND_SPAN + 1), range(base + 1, pref))
        for port in candidates:
            if self._is_free(port, name, table):
                self.record(port, name, role)
                return port
        raise PortExhausted(
            f"no free {role} port for '{name}' in band "
            f"{base + 1}-{base + BAND_SPAN}"
        )

    def _is_reusable(self, port: int, name: str, table: ProcTable) -> bool:
        if port in RESERVED_PORTS:
            return False
        listeners = table.listeners(port)
        if not listeners:
            return True
        return all(p.instance == name and p.killable for p in listeners)

    def _is_free(self, port: int, name: str, table: ProcTable) -> bool:
        """A port is free when it is unreserved, unlistened, and unleased.

        An existing lease held by someone else always blocks, even when that
        holder shows no live process. Liveness is ``reconcile``'s job, and it
        runs first; deciding it again here would reintroduce the exact race the
        ledger exists to close — an instance that has recorded its port but not
        yet spawned looks dead, so a concurrent allocator would hand the same
        port out twice.
        """
        if port in RESERVED_PORTS:
            return False
        if table.port_in_use(port):
            return False
        held = self.leases.get(port)
        if held is not None and held.instance != name:
            return False
        return True


def kill_allowed(port: int, name: str, table: ProcTable) -> bool:
    """May we signal whatever is listening on ``port`` on behalf of ``name``?

    True only when there IS a listener and **every** listener on that port is
    ownership-verified as belonging to ``name``. Returns False when the port is
    empty (nothing to kill), when any listener belongs to someone else, and when
    socket attribution is unavailable — in which case guessing is exactly the
    behavior that made ``kill`` dangerous.
    """
    if table.ports_degraded:
        return False
    listeners = table.listeners(port)
    if not listeners:
        return False
    return all(p.instance == name and p.killable for p in listeners)
