"""The ownership predicate. One process-table scan, reused by every command.

**The invariant this module exists to enforce:** no code path may signal a PID
unless that PID's tier is ``>= KILL_TIER`` *and* its resolved instance equals
the target name. Port occupancy is never sufficient.

That rule is the fix for three separate defects in the bash launcher it
replaces: ``status`` reporting ``[UP]`` because *someone* listens on a port
(four stale registries all claimed :5007 while one unrelated vite was the only
live process), ``kill`` terminating a stranger that had recycled a recorded port
(``kill tmpl-3`` would SIGTERM dev-2's frontend), and a registry-less instance
being unkillable because the port fallback was the only path and it was dead
code.

Every failure mode resolves **closed**: an unreadable environ, an unattributable
socket, or a mismatched ``create_time`` all mean "not owned", never "probably
ours". Under-claiming leaves an orphan for ``reap`` to report; over-claiming
kills someone else's backend mid-test.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace

from .model import KILL_TIER, Role, Tier

#: argv fragments that identify a backend / frontend process.
#: Deliberately narrow. ``npm`` is NOT a frontend marker: an instance's spawned
#: workers (claude, playwright-mcp, esbuild helpers) run under npm/node too, and
#: labelling those as the dev server made a status table claim a frontend was up
#: when the real one was a worker child.
_BACKEND_MARKER = "flow_sdk.server.run"
_FRONTEND_MARKER = "vite"


@dataclass(frozen=True)
class ProcInfo:
    pid: int
    ppid: int
    create_time: float | None
    name: str
    cmdline: tuple[str, ...]
    instance: str | None
    tier: Tier
    role: Role | None
    listen_ports: frozenset[int] = frozenset()

    @property
    def killable(self) -> bool:
        return self.instance is not None and self.tier >= KILL_TIER

    @property
    def cmd(self) -> str:
        return " ".join(self.cmdline)


@dataclass
class ProcTable:
    """A point-in-time view of every process that could belong to an instance."""

    procs: dict[int, ProcInfo] = field(default_factory=dict)
    #: True when the OS refused to attribute listening sockets. Port-derived
    #: evidence is unavailable, so every port-gated kill must refuse.
    ports_degraded: bool = False
    #: port → pids listening on it, built once during ``scan``. Without it,
    #: ``listeners()`` is a linear pass over every process and is called per
    #: role, per lease and per candidate port during allocation — the multiplier
    #: that made conflict detection quadratic on a machine with many instances.
    port_index: dict[int, list[int]] = field(default_factory=dict)
    #: ppid → child pids, also built once. Lineage shape is fixed for a
    #: snapshot, so re-deriving it on every adopt was pure waste.
    _children: dict[int, list[int]] = field(default_factory=dict)

    # ── lookups ──────────────────────────────────────────────────────────────
    def owner_of(self, pid: int) -> ProcInfo | None:
        return self.procs.get(pid)

    def owned_by(self, name: str, *, min_tier: Tier = KILL_TIER) -> list[ProcInfo]:
        return [
            p for p in self.procs.values()
            if p.instance == name and p.tier >= min_tier
        ]

    def instances(self, *, min_tier: Tier = KILL_TIER) -> set[str]:
        return {
            p.instance for p in self.procs.values()
            if p.instance is not None and p.tier >= min_tier
        }

    def listeners(self, port: int) -> list[ProcInfo]:
        return [self.procs[pid] for pid in self.port_index.get(port, ()) if pid in self.procs]

    def port_owner(self, port: int) -> str | None:
        """The instance owning ``port``, or None if unattributable or contested.

        Requires *every* listener to be the same, kill-tier-verified instance —
        an unattributable listener may not hide behind an attributable one.
        """
        ls = self.listeners(port)
        if not ls:
            return None
        names = {p.instance for p in ls}
        verified = {p.instance for p in ls if p.tier >= KILL_TIER}
        if len(names) == 1 and names == verified and None not in names:
            return next(iter(names))
        return None

    def is_owned_by(self, pid: int, name: str) -> bool:
        p = self.procs.get(pid)
        return bool(p and p.instance == name and p.tier >= KILL_TIER)

    def port_in_use(self, port: int) -> bool:
        return bool(self.listeners(port))

    # ── promotion ────────────────────────────────────────────────────────────
    def adopt_recorded(self, name: str, pid: int | None, create_time: float | None) -> bool:
        """Promote a PID this instance's own registry recorded to ``RECORDED``.

        This is how a process whose ``environ()`` we cannot read (macOS argv
        truncation, a re-exec that dropped the var) stays killable — but only
        for the instance whose registry names it, and only when ``create_time``
        matches, so a recycled PID can never be adopted.

        Records written before ``create_time`` existed carry ``None``; those are
        NOT adopted, because without it a recycled PID is indistinguishable from
        the original. They remain reachable via ENV or lineage.
        """
        if pid is None or create_time is None:
            return False
        p = self.procs.get(pid)
        if p is None or p.create_time is None:
            return False
        if abs(p.create_time - create_time) > 1.0:
            return False
        if p.instance is not None and p.instance != name:
            return False
        if p.tier >= Tier.RECORDED and p.instance == name:
            return True
        self.procs[pid] = replace(p, instance=name, tier=Tier.RECORDED)
        self.close_lineage([pid])
        return True

    def adopt_server_json(self, name: str, pid: int | None, port: int | None) -> bool:
        """Promote the backend PID that ``<instance>/server.json`` records.

        Needed because a backend does not necessarily carry ``FLOW_INSTANCE`` in
        its process environment: instances started by hand (``oss``, ``prod``)
        pick the name up from ``.env.local`` via dotenv *inside* the process, so
        ``environ()`` never shows it. Without this they read as unowned, and a
        hand-started backend would be reported as a stranger on its own port.

        ``server.json`` has no ``create_time``, so recycling is guarded
        differently: the file is written by that instance's own backend into
        that instance's own directory, and we additionally require the process
        to still look like a backend or to hold the recorded port. A recycled
        PID would have to be a *different* Flowpad backend serving that exact
        port to slip through, at which point it is the instance's backend by
        every meaningful definition.
        """
        if pid is None:
            return False
        p = self.procs.get(pid)
        if p is None:
            return False
        if p.instance is not None and p.instance != name:
            return False
        looks_right = (
            _BACKEND_MARKER in p.cmd
            or (port is not None and port in p.listen_ports)
        )
        if not looks_right:
            return False
        if p.tier < Tier.RECORDED or p.instance != name:
            self.procs[pid] = replace(p, instance=name, tier=Tier.RECORDED)
            self.close_lineage([pid])
        return True

    def close_lineage(self, roots) -> None:
        """Stamp every descendant of ``roots`` with its owner, at ``LINEAGE``.

        The one implementation of the promotion rule, used both by the initial
        scan (rooted at every env-owned process) and by each adopt. There used
        to be two copies, which meant the rule was written twice and could
        drift between the scan path and the adopt path. It walks the cached
        ``_children`` index rather than rebuilding it — lineage shape is fixed
        for a snapshot, and adopts only ever change ``instance``/``tier``.
        """
        stack = [(pid, self.procs[pid].instance) for pid in roots if pid in self.procs]
        seen = {pid for pid, _ in stack}
        while stack:
            pid, owner = stack.pop()
            for child_pid in self._children.get(pid, ()):
                if child_pid in seen:
                    continue
                seen.add(child_pid)
                child = self.procs.get(child_pid)
                if child is not None and child.tier < Tier.LINEAGE:
                    self.procs[child_pid] = replace(
                        child, instance=owner, tier=Tier.LINEAGE
                    )
                stack.append((child_pid, owner))


def scan(*, want_ports: bool = True) -> ProcTable:
    """Build a ``ProcTable`` from one ``process_iter`` pass (+ one socket pass).

    The bash launcher shelled out to ``lsof`` per port and ran a fresh ``ps``
    per instance; a single table shared by every command is both faster and
    consistent — two rows of a status table can no longer disagree about
    whether the same PID is alive.
    """
    import psutil

    gone = (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess)
    table = ProcTable()
    children: dict[int, list[int]] = {}

    # ── pass 1: identity from the process environment ────────────────────────
    for proc in psutil.process_iter(["pid", "ppid", "name", "cmdline", "create_time"]):
        info = proc.info
        pid = info.get("pid")
        if pid is None:
            continue
        cmdline = tuple(info.get("cmdline") or ())

        instance: str | None = None
        tier = Tier.NONE
        try:
            # A zombie has no meaningful environment and cannot own anything.
            if proc.status() != psutil.STATUS_ZOMBIE:
                env_name = proc.environ().get("FLOW_INSTANCE")
                if env_name:
                    instance, tier = env_name, Tier.ENV
        except (*gone, OSError):
            # AccessDenied (another user's process) or macOS argv truncation.
            # Fail closed: unattributed, never killed.
            pass

        if instance is None:
            cmd_name = _instance_from_cmdline(cmdline)
            if cmd_name is not None:
                instance, tier = cmd_name, Tier.CMDLINE

        table.procs[pid] = ProcInfo(
            pid=pid,
            ppid=info.get("ppid") or 0,
            create_time=info.get("create_time"),
            name=info.get("name") or "",
            cmdline=cmdline,
            instance=instance,
            tier=tier,
            role=_role_from_cmdline(cmdline),
        )
        children.setdefault(info.get("ppid") or 0, []).append(pid)

    table._children = children
    table.close_lineage(
        p.pid for p in list(table.procs.values()) if p.tier >= Tier.ENV
    )
    if want_ports:
        _attach_listen_ports(table)
    return table


def _attach_listen_ports(table: ProcTable) -> None:
    """Attach listening ports to their processes.

    Tries the system-wide call first and falls back to per-process sockets:
    on macOS the system-wide call is frequently refused for non-root callers,
    but a process we launched ourselves will answer for its own sockets. When
    neither works, ``ports_degraded`` is set and every port-gated decision
    refuses rather than guessing.
    """
    import psutil

    gone = (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess)
    by_pid: dict[int, set[int]] = {}

    got_systemwide = False
    try:
        for conn in psutil.net_connections(kind="inet"):
            if conn.status != psutil.CONN_LISTEN or not conn.laddr or not conn.pid:
                continue
            by_pid.setdefault(conn.pid, set()).add(conn.laddr.port)
        got_systemwide = True
    except (psutil.AccessDenied, OSError):
        pass

    if not got_systemwide:
        for pid in list(table.procs):
            try:
                proc = psutil.Process(pid)
                conns = proc.net_connections(kind="inet")
            except (*gone, OSError):
                continue
            for conn in conns:
                if conn.status == psutil.CONN_LISTEN and conn.laddr:
                    by_pid.setdefault(pid, set()).add(conn.laddr.port)
        table.ports_degraded = not by_pid

    for pid, ports in by_pid.items():
        for port in ports:
            table.port_index.setdefault(port, []).append(pid)
        p = table.procs.get(pid)
        if p is not None:
            table.procs[pid] = replace(p, listen_ports=frozenset(ports))


def _instance_from_cmdline(cmdline: tuple[str, ...]) -> str | None:
    """Best-effort instance name from argv — REPORT-ONLY evidence.

    Recognizes ``vite --mode <name>`` and a ``.env.<name>.local`` argument. Never
    promotes past ``CMDLINE``, so this can label an orphan in a table without
    ever making it a kill target.
    """
    for i, tok in enumerate(cmdline):
        if tok == "--mode" and i + 1 < len(cmdline):
            return cmdline[i + 1]
        if tok.startswith("--mode="):
            return tok.split("=", 1)[1] or None
        base = tok.rsplit("/", 1)[-1]
        if base.startswith(".env.") and base.endswith(".local"):
            return base[len(".env."):-len(".local")] or None
    return None


def _role_from_cmdline(cmdline: tuple[str, ...]) -> Role | None:
    """The role a process plays, or None for anything else it owns.

    None is the common and correct answer: an instance's spawned workers are
    genuinely its processes (so they reap with it) without being its backend or
    its dev server.
    """
    joined = " ".join(cmdline)
    if _BACKEND_MARKER in joined:
        return Role.BACKEND
    if _FRONTEND_MARKER in joined:
        return Role.FRONTEND
    return None
