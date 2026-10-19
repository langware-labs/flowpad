"""Killing is ownership-gated. This is the most important file in the suite.

The bug it pins: the bash launcher killed whatever was listening on the port its
*registry* recorded. Ports were probed rather than reserved and the band
recycled, so on a real machine three registries claimed frontend 5003 —
``dev-2``, ``hubqa25-2`` and ``tmpl-3`` — and running ``kill tmpl-3`` would
SIGTERM dev-2's live frontend. That was verified by hand against the old script
before it was replaced: it killed the bystander.

Every test here spawns real processes, because ownership is "what does this
PID's environment say" and a mocked process table would only test the mock.

**Every instance name comes from the ``iname`` fixture, and every reap is
scoped with ``only=``.** The process table is machine-global — ``FLOW_HOME``
cannot redirect it — so a test that spawns a child literally named ``dev-2``
and kills "dev-2" will terminate the developer's real dev-2 frontend, and an
unscoped ``reap()`` against a throwaway instance root treats every real
instance on the box as unaccounted-for. Both of those happened while writing
this file. Do not reintroduce a bare name here.

Note the positive control (``test_kill_does_reap_its_own_processes``): without
it, an over-strict gate would make every isolation assertion pass trivially by
turning ``kill`` into a no-op.
"""

from __future__ import annotations

import json

import pytest

from flow_sdk.instances import liveness, manager, paths, procs, registry
from flow_sdk.instances.model import InstanceKind, LauncherRecord, ProcRef, Role
from flow_sdk.instances.ports import PortLedger
from flow_sdk.instances.reconcile import reconcile

pytestmark = pytest.mark.usefixtures("instances_home")


def _alive(proc) -> bool:
    return proc.poll() is None


def _record(name, *, be=None, fe=None, kind=InstanceKind.FULL, group=None):
    rec = LauncherRecord(
        name=name, group=group or name, kind=kind,
        env_file=str(paths.env_file(name)), repo_root=str(paths.repo_root()),
        backend=be or ProcRef(), frontend=fe or ProcRef(),
    )
    registry.write(rec)
    return rec


def _ref(proc, port=None):
    import psutil

    return ProcRef(pid=proc.pid, port=port, create_time=psutil.Process(proc.pid).create_time())


# ── THE hazard ───────────────────────────────────────────────────────────────
def test_a_ghost_registry_cannot_kill_the_stranger_holding_its_port(
    spawn_owned, free_port, iname
):
    """Killing the ghost must not touch the live instance whose port it
    happens to record — the dev-2/tmpl-3 collision, reproduced."""
    victim_name, ghost_name = iname("victim"), iname("ghost")
    port = free_port()
    victim = spawn_owned(victim_name, port=port)
    _record(victim_name, fe=_ref(victim, port))
    _record(ghost_name, fe=ProcRef(pid=999_999, port=port))

    table = liveness.scan()
    if table.ports_degraded:
        pytest.skip("socket attribution unavailable in this environment")

    result = procs.kill_port_if_owned(port, ghost_name, table)

    assert result.killed == []
    assert result.refused and ghost_name in result.refused[0]
    assert _alive(victim), "the live instance was killed by a kill of the ghost"
    assert registry.exists(victim_name)


def test_registry_poisoning_cannot_borrow_another_instances_live_pid(
    spawn_owned, iname
):
    """A stale registry naming a PID that demonstrably belongs to someone else
    must not authorize a kill of it."""
    import psutil

    victim_name, ghost_name = iname("victim"), iname("ghost")
    victim = spawn_owned(victim_name)
    ct = psutil.Process(victim.pid).create_time()
    _record(ghost_name, fe=ProcRef(pid=victim.pid, create_time=ct))

    table = liveness.scan(want_ports=False)
    assert table.adopt_recorded(ghost_name, victim.pid, ct) is False

    result = procs.kill_owned(ghost_name, table)
    assert result.killed == []
    assert _alive(victim)


def test_kill_does_reap_its_own_processes(spawn_owned, iname):
    """POSITIVE CONTROL. Without this, the isolation tests above would pass
    just as well if `kill` did nothing at all."""
    name = iname("own")
    victim = spawn_owned(name)
    _record(name, fe=_ref(victim))

    result = procs.kill_owned(name, liveness.scan(want_ports=False))

    assert victim.pid in result.killed
    assert result.survivors == []
    victim.wait(timeout=5)
    assert not _alive(victim)


def test_kill_reaps_the_child_tree(spawn_owned, iname):
    """vite's esbuild helper and a backend's PTY children are never recorded
    individually; lineage is the only thing that finds them."""
    import os
    import subprocess
    import sys

    name = iname("tree")
    parent = spawn_owned(name)
    env = dict(os.environ)
    env["FLOW_INSTANCE"] = name
    child = subprocess.Popen(
        [sys.executable, "-c",
         "import sys,time; sys.stdout.write('ready\\n'); sys.stdout.flush(); time.sleep(300)"],
        env=env, stdout=subprocess.PIPE, text=True,
    )
    try:
        assert child.stdout.readline().strip() == "ready"
        result = procs.kill_owned(name, liveness.scan(want_ports=False))
        assert {parent.pid, child.pid} <= set(result.killed)
        child.wait(timeout=5)
        assert not _alive(child)
    finally:
        if _alive(child):
            child.kill()
            child.wait()


def test_kill_on_a_never_allocated_name_is_a_complete_no_op(
    spawn_owned, free_port, iname
):
    """The defining property of a safe teardown: an unknown name must not scan
    ports, read the ledger, or signal anything."""
    name = iname("bystander")
    port = free_port()
    bystander = spawn_owned(name, port=port)
    _record(name, fe=_ref(bystander, port))

    result = procs.kill_owned(iname("never-allocated"), liveness.scan())

    assert result.killed == []
    assert result.survivors == []
    assert _alive(bystander)


def test_a_role_filter_spares_the_other_half(iname):
    """`restart-backend` must not take the vite down with it — the frontend
    also carries FLOW_INSTANCE, so only a role filter separates them."""
    import os
    import subprocess
    import sys

    name = iname("roles")
    env = dict(os.environ)
    env["FLOW_INSTANCE"] = name
    ready = ("import sys,time; sys.stdout.write('ready\\n'); "
             "sys.stdout.flush(); time.sleep(300)")
    backend = subprocess.Popen(
        [sys.executable, "-c", ready, "flow_sdk.server.run"],
        env=env, stdout=subprocess.PIPE, text=True,
    )
    frontend = subprocess.Popen(
        [sys.executable, "-c", ready, "vite", "--mode", name],
        env=env, stdout=subprocess.PIPE, text=True,
    )
    try:
        assert backend.stdout.readline().strip() == "ready"
        assert frontend.stdout.readline().strip() == "ready"

        result = procs.kill_owned(
            name, liveness.scan(want_ports=False), roles=frozenset({Role.BACKEND})
        )

        assert backend.pid in result.killed
        assert frontend.pid not in result.killed
        backend.wait(timeout=5)
        assert _alive(frontend)
    finally:
        for p in (backend, frontend):
            if _alive(p):
                p.kill()
                p.wait()


def test_port_cleanup_keeps_the_backend_role_filter(free_port, iname):
    """A backend-only port sweep must not widen into an all-instance kill."""
    import os
    import subprocess
    import sys

    name = iname("port-roles")
    port = free_port()
    env = dict(os.environ)
    env["FLOW_INSTANCE"] = name
    listener = (
        "import socket,sys,time; "
        "s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); "
        f"s.bind(('127.0.0.1',{port})); s.listen(1); "
        "sys.stdout.write('ready\\n'); sys.stdout.flush(); time.sleep(300)"
    )
    ready = (
        "import sys,time; sys.stdout.write('ready\\n'); "
        "sys.stdout.flush(); time.sleep(300)"
    )
    backend = subprocess.Popen(
        [sys.executable, "-c", listener, "flow_sdk.server.run"],
        env=env,
        stdout=subprocess.PIPE,
        text=True,
    )
    frontend = subprocess.Popen(
        [sys.executable, "-c", ready, "vite", "--mode", name],
        env=env,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert backend.stdout.readline().strip() == "ready"
        assert frontend.stdout.readline().strip() == "ready"
        table = liveness.scan()
        if table.ports_degraded:
            pytest.skip("socket attribution unavailable in this environment")

        result = procs.kill_port_if_owned(
            port,
            name,
            table,
            roles=frozenset({Role.BACKEND}),
        )

        assert backend.pid in result.killed
        assert frontend.pid not in result.killed
        backend.wait(timeout=5)
        assert _alive(frontend)
    finally:
        for p in (backend, frontend):
            if _alive(p):
                p.kill()
                p.wait()


# ── reconcile ────────────────────────────────────────────────────────────────
def test_reconcile_clears_a_dead_pid_but_keeps_the_port(iname):
    """The port is what makes a relaunch land back where it was; the PID is a
    claim that has stopped being true."""
    name = iname("dead")
    _record(name, be=ProcRef(pid=999_999, port=6001, log="/tmp/be.log"))

    report = reconcile([name])
    assert any(f"{name}/backend" in c for c in report.cleared_pids)

    rec = registry.read(name)
    assert rec.backend.pid is None
    assert rec.backend.port == 6001
    assert rec.backend.log == "/tmp/be.log"


def test_reconcile_deletes_a_server_json_naming_a_dead_backend(iname):
    """A stale server.json is not inert: `flow hooks report` POSTs to every one
    it finds, so once the port band recycles it delivers hook payloads into a
    live, unrelated backend."""
    name = iname("crashed")
    d = paths.instance_dir(name)
    d.mkdir(parents=True)
    (d / "server.json").write_text(json.dumps({"port": 6004, "server_pid": 999_999}))

    report = reconcile([name])
    assert report.removed_server_json == [name]
    assert not (d / "server.json").exists()


def test_reconcile_keeps_a_server_json_whose_backend_is_alive(
    spawn_owned, free_port, iname
):
    name = iname("live")
    port = free_port()
    proc = spawn_owned(name, port=port, env_instance=False)
    d = paths.instance_dir(name)
    d.mkdir(parents=True)
    (d / "server.json").write_text(json.dumps({"port": port, "server_pid": proc.pid}))

    table = liveness.scan()
    if table.ports_degraded:
        pytest.skip("socket attribution unavailable in this environment")

    report = reconcile([name], table=table)
    assert report.removed_server_json == []
    assert (d / "server.json").exists()


def test_reconcile_removes_singleton_locks_nobody_holds(iname):
    """run.py releases the lock on a clean exit but never unlinked the files, so
    every instance that ever ran kept a pair — 268 of them on one machine."""
    name = iname("locked")
    d = paths.instance_dir(name)
    d.mkdir(parents=True)
    (d / "server.lock").write_text("")
    (d / "server.pid").write_text("999999")

    report = reconcile([name])
    assert report.removed_locks == [name]
    assert not (d / "server.lock").exists()
    assert not (d / "server.pid").exists()


def test_reconcile_drops_a_lease_nothing_holds(iname):
    name = iname("leaser")
    with PortLedger.open() as ledger:
        ledger.record(6042, name, Role.BACKEND)
    report = reconcile([])
    assert 6042 in report.dropped_leases
    assert PortLedger.load().leases == {}


def test_reconcile_dry_run_changes_nothing(instances_home, iname):
    name = iname("crashed")
    d = paths.instance_dir(name)
    d.mkdir(parents=True)
    (d / "server.json").write_text(json.dumps({"port": 6004, "server_pid": 999_999}))
    _record(iname("dead"), be=ProcRef(pid=999_999, port=6001))

    before = instances_home.snapshot()
    report = reconcile(dry_run=True)

    assert report.changed          # it found things
    assert instances_home.snapshot() == before   # and touched none of them


def test_reconcile_never_touches_data(iname):
    """Databases, sodot and keychain entries are not the control plane."""
    name = iname("data")
    d = paths.instance_dir(name)
    d.mkdir(parents=True)
    (d / "server.json").write_text(json.dumps({"port": 6009, "server_pid": 999_999}))
    (d / "flowpad.db").write_bytes(b"precious")
    (d / "sodot").write_bytes(b"secret")

    reconcile([name])

    assert (d / "flowpad.db").read_bytes() == b"precious"
    assert (d / "sodot").read_bytes() == b"secret"
    assert not (d / "server.json").exists()


# ── reap ─────────────────────────────────────────────────────────────────────
def test_reap_kills_a_registry_less_process(spawn_owned, iname):
    """The population the old launcher created and could not name: gc deleted
    the registry, kill needed one to find its ports, so the process ran on."""
    name = iname("orphan")
    orphan = spawn_owned(name)

    plan = manager.reap(dry_run=True, only={name})
    assert plan["instances"] == [name]

    manager.reap(only={name})
    orphan.wait(timeout=5)
    assert not _alive(orphan)


def test_reap_dry_run_kills_nothing(spawn_owned, iname):
    name = iname("orphan")
    orphan = spawn_owned(name)
    plan = manager.reap(dry_run=True, only={name})
    assert plan["killed"] == []
    assert _alive(orphan)


def test_reap_spares_a_registered_instance(spawn_owned, iname):
    keeper_name, orphan_name = iname("keeper"), iname("orphan")
    keeper = spawn_owned(keeper_name)
    _record(keeper_name, fe=_ref(keeper))
    spawn_owned(orphan_name)

    manager.reap(only={keeper_name, orphan_name})
    assert _alive(keeper)


def test_reap_spares_protected_instances(spawn_owned, iname, monkeypatch):
    name = iname("protected")
    monkeypatch.setenv("PROTECTED_INSTANCES", name)
    protected = spawn_owned(name)   # live, but no registry

    plan = manager.reap(dry_run=True, only={name})
    assert plan["instances"] == []
    assert name in plan["skipped_protected"]

    manager.reap(only={name})
    assert _alive(protected)


def test_reap_spares_a_self_managed_instance_and_its_workers(
    spawn_owned, free_port, iname
):
    """`oss`/`prod` never get a launcher.json. Reaping one would kill a
    developer's working backend and every claude worker beneath it."""
    name = iname("selfmanaged")
    port = free_port()
    backend = spawn_owned(name, port=port, env_instance=False)
    worker = spawn_owned(name)   # a worker child, env-owned
    d = paths.instance_dir(name)
    d.mkdir(parents=True)
    (d / "server.json").write_text(json.dumps({"port": port, "server_pid": backend.pid}))

    if liveness.scan().ports_degraded:
        pytest.skip("socket attribution unavailable in this environment")

    plan = manager.reap(dry_run=True, only={name})
    assert plan["instances"] == []

    manager.reap(only={name})
    assert _alive(backend)
    assert _alive(worker)


def test_reap_is_scoped_by_only(spawn_owned, iname):
    """The scoping that keeps a throwaway instance root from reaping the whole
    machine. Without it, every real instance looks unaccounted-for."""
    mine, theirs = iname("mine"), iname("theirs")
    a, b = spawn_owned(mine), spawn_owned(theirs)

    manager.reap(only={mine})
    a.wait(timeout=5)
    assert not _alive(a)
    assert _alive(b), "reap ignored its `only` scope"


# ── gc ───────────────────────────────────────────────────────────────────────
def test_gc_never_deletes_the_dir_of_a_running_orphan(spawn_owned, iname):
    """The old gc could, which is exactly how a process ended up with no
    registry and no way to name it. Reaping runs first here."""
    name = iname("running")
    spawn_owned(name)
    d = paths.instance_dir(name)
    d.mkdir(parents=True)
    (d / "flowpad.db").write_bytes(b"x")

    plan = manager.gc(age_days=0, dry_run=True, only={name})
    assert plan["removed_dirs"] == []


def test_gc_respects_the_age_window_for_data_destruction(iname):
    name = iname("dead")
    d = paths.instance_dir(name)
    d.mkdir(parents=True)
    (d / "flowpad.db").write_bytes(b"x")

    # Age gates DATA destruction, so a just-touched dir survives...
    assert manager.gc(age_days=14, dry_run=True, only={name})["removed_dirs"] == []
    # ...and with no age window it is collectable.
    assert manager.gc(age_days=0, dry_run=True, only={name})["removed_dirs"] == [name]


def test_gc_dry_run_deletes_nothing(instances_home, iname):
    name = iname("dead")
    d = paths.instance_dir(name)
    d.mkdir(parents=True)
    (d / "flowpad.db").write_bytes(b"x")

    before = instances_home.snapshot()
    manager.gc(age_days=0, dry_run=True, only={name})
    assert instances_home.snapshot() == before


def test_gc_spares_registered_and_protected_instances(iname, monkeypatch):
    protected_name, keeper_name = iname("protected"), iname("keeper")
    monkeypatch.setenv("PROTECTED_INSTANCES", protected_name)
    for n in (protected_name, keeper_name):
        paths.instance_dir(n).mkdir(parents=True)
    _record(keeper_name)

    removable = manager.gc(
        age_days=0, dry_run=True, only={protected_name, keeper_name}
    )["removed_dirs"]
    assert removable == []
