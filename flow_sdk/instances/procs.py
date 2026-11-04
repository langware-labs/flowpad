"""Spawning and killing, with ownership as the only licence to signal.

``kill_owned`` is the single choke point through which every signal in this
package passes. It refuses to touch a PID that is not ownership-verified for the
target instance, which is what makes ``kill tmpl-3`` unable to terminate dev-2's
frontend even when tmpl-3's registry records dev-2's port.

Killing is batched — collect every target, SIGTERM all, wait once, SIGKILL the
survivors — because a degraded instance can own dozens of leaked PTY/claude
children, and terminating them one at a time turns a seconds-long teardown into
a minutes-long one. This mirrors the batching already proven in
``instance_cmd._kill_instance_processes``, which this supersedes.
"""

from __future__ import annotations

import logging
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

from .liveness import ProcInfo, ProcTable
from .model import ProcRef, Role

logger = logging.getLogger(__name__)

#: Seconds to wait after SIGTERM before escalating, and after SIGKILL before
#: declaring a survivor. These are escalation steps in a shutdown ladder, not
#: budgets that mask a symptom — a process that ignores SIGKILL is a real
#: failure to report, never something to wait longer for.
_TERM_GRACE = 3.0
_KILL_GRACE = 2.0


@dataclass
class KillResult:
    instance: str
    killed: list[int] = field(default_factory=list)
    survivors: list[int] = field(default_factory=list)
    refused: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        # A refusal is NOT success: a protected process the guard spared is still running,
        # so a caller must not read `ok` as "nothing of it is left". Both lists must be empty.
        return not self.survivors and not self.refused

    def to_json(self) -> dict:
        return {
            "instance": self.instance,
            "killed": sorted(self.killed),
            "survivors": sorted(self.survivors),
            "refused": self.refused,
        }


def kill_owned(
    name: str,
    table: ProcTable,
    *,
    roles: frozenset[Role] | None = None,
    extra: list[ProcInfo] | None = None,
    allow_protected: bool = False,
) -> KillResult:
    """Terminate every process ownership-verified as ``name``'s.

    ``roles`` restricts the sweep (``restart-backend`` must spare the vite,
    which also carries ``FLOW_INSTANCE``). Processes with no role — an
    instance's spawned workers — are only swept when no role filter is given,
    since they belong to the instance as a whole rather than to one half of it.

    ``allow_protected`` passes through to ``terminate_tree`` for enforcement: left False
    (the default) the FLOWPAD-2112 port guard spares this instance's own live backend (and
    its ancestor chain), recording each spared pid in ``result.refused`` so the refusal is
    visible and not mistaken for success. A user-requested restart/reset passes True so the
    backend can actually be reaped.
    """
    import psutil

    result = KillResult(instance=name)
    gone = (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess)
    self_pid = os.getpid()

    candidates = list(table.owned_by(name)) + list(extra or [])
    targets: dict[int, psutil.Process] = {}
    for info in candidates:
        if info.pid == self_pid:
            continue
        # `None not in frozenset({...})` is already True, so one test covers
        # both "wrong role" and "no role" — a role filter targets one half of
        # an instance, never its unclassified workers.
        if roles is not None and info.role not in roles:
            continue
        try:
            targets[info.pid] = psutil.Process(info.pid)
        except gone:
            continue

    # terminate_tree applies the guard and reports back which roots it spared, so the guard
    # runs ONCE (not a separate protected() pre-call here) and a refusal reaches the result.
    result.killed, result.survivors, refused = terminate_tree(
        list(targets.values()), allow_protected=allow_protected
    )
    for pid in refused:
        result.refused.append(
            f"pid {pid} is (or contains) this instance's live backend — refused by the "
            f"self-protection guard"
        )
    return result


def terminate_tree(roots: list, *, allow_protected: bool = False) -> tuple[list[int], list[int], list[int]]:
    """The shutdown ladder over *roots* (``psutil.Process``) and every descendant: SIGTERM all,
    wait once, SIGKILL the survivors. ``(killed, survivors, refused)`` pids. Never this process.

    The caller has already decided the roots are its own; this only reaps them — batched,
    because a degraded tree can hold dozens of children and one-at-a-time takes minutes.

    ``allow_protected`` left False (the default) applies the FLOWPAD-2112 port guard: a ROOT
    whose subtree holds the live backend (the backend, or an ancestor above it) is spared
    WHOLE — it is dropped before its tree is expanded, so the backend's own children (workers,
    MCP servers, web apps) are never swept along with it, and its pid is returned in ``refused``
    so the caller does NOT read a spared process as stopped. A user-requested restart/reset
    passes True to reap its own backend.
    """
    import psutil

    gone = (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess)
    self_pid = os.getpid()
    roots = [p for p in roots if p.pid != self_pid]
    refused_pids: list[int] = []
    if not allow_protected and roots:
        from flow_sdk.core import port_guard  # noqa: PLC0415

        refused = port_guard.protected([p.pid for p in roots])
        if refused:
            logger.warning("[port_guard] terminate_tree sparing protected FlowPad tree(s) %s", sorted(refused))
            roots = [p for p in roots if p.pid not in refused]
            refused_pids = sorted(refused)

    targets = {p.pid: p for p in roots}
    # Descend the tree as well: children spawned after the roots were found (a
    # backend that forked a worker a moment ago) are still ours to reap. A root whose
    # subtree held the backend was already dropped above, so no expansion reaches it.
    for pid in list(targets):
        try:
            for child in targets[pid].children(recursive=True):
                if child.pid != self_pid and child.pid not in targets:
                    targets[child.pid] = child
        except gone:
            pass

    procs = list(targets.values())
    for p in procs:
        try:
            p.terminate()
        except gone:
            pass
    _, alive = psutil.wait_procs(procs, timeout=_TERM_GRACE)
    for p in alive:
        try:
            p.kill()
        except gone:
            pass
    _, survivors = psutil.wait_procs(alive, timeout=_KILL_GRACE)
    return sorted(targets), sorted(p.pid for p in survivors), refused_pids


def kill_port_if_owned(
    port: int,
    name: str,
    table: ProcTable,
    *,
    roles: frozenset[Role] | None = None,
    allow_protected: bool = False,
) -> KillResult:
    """Kill the listener on ``port`` only if it is verifiably ``name``'s.

    The bash implementation killed whatever the registry's recorded port
    happened to hold, which on a machine with a recycled port band meant
    terminating a stranger. Refusals are recorded rather than silently skipped,
    so the collision is visible in the result.

    ``allow_protected`` passes through to ``kill_owned`` so a user-requested
    restart/reset can reap this instance's own backend listener.
    """
    from .ports import kill_allowed

    result = KillResult(instance=name)
    if not kill_allowed(port, name, table):
        holders = table.listeners(port)
        if holders:
            owner = table.port_owner(port) or "an unattributable process"
            result.refused.append(
                f"port {port} is held by {owner}, not '{name}' — refusing to signal it"
            )
        return result
    return kill_owned(
        name, table, roles=roles, extra=table.listeners(port), allow_protected=allow_protected
    )


def spawn_detached(
    argv: list[str],
    *,
    env: dict[str, str],
    log: Path,
    cwd: Path,
) -> ProcRef:
    """Start a child that outlives this process, and record enough to reap it.

    Detachment is deliberate: instances have to survive the shell (or the QA
    agent) that launched them. The failure that follows from detachment alone is
    the one this package exists to fix — nothing supervised the child, so a
    frontend outlived its backend by days. The answer is not to re-attach but to
    record ``pgid`` and ``create_time`` here, so ``kill_owned`` can reap the
    whole process group later and a recycled PID can never be mistaken for it.
    """
    import subprocess

    import psutil

    from flow_sdk.utils.environment import without_worker_signal

    # FLOWPAD-2112: a detached instance process (a backend) is never a worker — strip the worker
    # signal here too, so this path matches start_detached_process and no spawn leaks it.
    env = without_worker_signal(env)
    log.parent.mkdir(parents=True, exist_ok=True)
    with open(log, "ab") as fh:
        kwargs: dict = {
            "cwd": str(cwd),
            "env": env,
            "stdout": fh,
            "stderr": fh,
            "stdin": subprocess.DEVNULL,
        }
        if sys.platform == "win32":  # pragma: no cover - posix dev machines
            # Mirrors server/launch.py::start_detached_process — CREATE_NO_WINDOW
            # matters, or every launched backend flashes a console window.
            kwargs["creationflags"] = (
                subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
            )
        else:
            kwargs["start_new_session"] = True
        proc = subprocess.Popen(argv, **kwargs)

    try:
        create_time = psutil.Process(proc.pid).create_time()
    except Exception:
        create_time = None
    try:
        pgid = os.getpgid(proc.pid) if sys.platform != "win32" else None
    except OSError:
        pgid = None

    return ProcRef(
        pid=proc.pid, pgid=pgid, create_time=create_time, log=str(log)
    )
