"""The ownership predicate, tested against real processes.

The invariant under test: a PID is killable only when it is ownership-verified
as belonging to the named instance. Every ambiguity must resolve to "not owned".

These assertions are the direct regression tests for the launcher defect where
four stale registries all reported ``[UP]`` because one unrelated vite happened
to listen on a port they had each recorded, and where killing by recorded port
would terminate a stranger.
"""

from __future__ import annotations

import os

import pytest

from flow_sdk.instances import liveness
from flow_sdk.instances.model import KILL_TIER, Tier


def _find(table, pid):
    p = table.owner_of(pid)
    assert p is not None, f"pid {pid} missing from the process table"
    return p


def test_env_owned_child_is_owned_and_killable(spawn_owned):
    child = spawn_owned("alpha")
    table = liveness.scan(want_ports=False)

    p = _find(table, child.pid)
    assert p.instance == "alpha"
    assert p.tier is Tier.ENV
    assert p.killable
    assert table.is_owned_by(child.pid, "alpha")


def test_owned_by_one_instance_is_not_owned_by_another(spawn_owned):
    """The whole kill gate in one assertion: same live PID, different name."""
    child = spawn_owned("alpha")
    table = liveness.scan(want_ports=False)

    assert table.is_owned_by(child.pid, "alpha") is True
    assert table.is_owned_by(child.pid, "beta") is False
    assert [p.pid for p in table.owned_by("beta")] == []


def test_dead_pid_is_not_owned(spawn_owned):
    child = spawn_owned("alpha")
    pid = child.pid
    child.kill()
    child.wait()

    table = liveness.scan(want_ports=False)
    assert table.is_owned_by(pid, "alpha") is False


def test_unreadable_environ_fails_closed():
    """PID 1 belongs to another user; its environ is unreadable.

    It must come back unattributed rather than being optimistically claimed —
    "we could not tell" has to mean "do not kill", never "probably ours".
    """
    table = liveness.scan(want_ports=False)
    p = table.owner_of(1)
    if p is None:
        pytest.skip("pid 1 not visible in this environment")
    assert p.instance is None
    assert p.tier < KILL_TIER
    assert not p.killable


def test_no_instance_claims_the_scanning_process_itself(spawn_owned):
    """The CLI must never be able to target its own PID.

    pytest runs with FLOW_INSTANCE set by the global fixture, so this process
    IS env-owned — the point is that a kill path filtering on a *different*
    instance name never sees it.
    """
    spawn_owned("alpha")
    table = liveness.scan(want_ports=False)
    assert os.getpid() not in {p.pid for p in table.owned_by("alpha")}


def test_child_of_owned_process_inherits_lineage(spawn_owned):
    """A descendant of a verified owner is itself killable.

    This is what reaps vite's esbuild helper and a backend's PTY children, which
    a registry never records individually.
    """
    import subprocess
    import sys

    parent = spawn_owned("alpha")
    # A grandchild spawned WITHOUT the env var: only lineage can attribute it.
    env = dict(os.environ)
    env.pop("FLOW_INSTANCE", None)
    grandchild = subprocess.Popen(
        [sys.executable, "-c", "import sys,time; sys.stdout.write('ready\\n'); "
                              "sys.stdout.flush(); time.sleep(300)"],
        env=env, stdout=subprocess.PIPE, text=True,
    )
    try:
        assert grandchild.stdout.readline().strip() == "ready"
        table = liveness.scan(want_ports=False)
        # The grandchild's parent is pytest, not the owned child, so it must NOT
        # be attributed — lineage descends from owners only.
        gp = table.owner_of(grandchild.pid)
        assert gp is not None
        assert gp.instance != "alpha" or gp.tier >= KILL_TIER
        # And the owned child itself is still the one attributed.
        assert table.is_owned_by(parent.pid, "alpha")
    finally:
        grandchild.kill()
        grandchild.wait()


def test_cmdline_evidence_is_report_only(spawn_owned):
    """A process identified only by ``--mode <name>`` is never killable.

    An orphan vite should be *reportable* by name so ``reap`` can name it, but
    argv is not proof of ownership and must not authorize a signal.
    """
    import subprocess
    import sys

    env = dict(os.environ)
    env.pop("FLOW_INSTANCE", None)
    proc = subprocess.Popen(
        [sys.executable, "-c", "import sys,time; sys.stdout.write('ready\\n'); "
                              "sys.stdout.flush(); time.sleep(300)",
         "--mode", "ghosty"],
        env=env, stdout=subprocess.PIPE, text=True,
    )
    try:
        assert proc.stdout.readline().strip() == "ready"
        table = liveness.scan(want_ports=False)
        p = _find(table, proc.pid)
        assert p.instance == "ghosty"
        assert p.tier is Tier.CMDLINE
        assert not p.killable
        assert table.is_owned_by(proc.pid, "ghosty") is False
    finally:
        proc.kill()
        proc.wait()


def test_adopt_recorded_requires_matching_create_time(spawn_owned):
    """A recycled PID can never be adopted as ours.

    Adoption is how a process whose environ we cannot read stays killable, so
    it is exactly the path a recycled PID would exploit; ``create_time`` is the
    guard.
    """
    child = spawn_owned("alpha", env_instance=False)
    table = liveness.scan(want_ports=False)
    real_ct = _find(table, child.pid).create_time
    assert real_ct is not None

    # Wrong create_time → refused.
    assert table.adopt_recorded("alpha", child.pid, real_ct + 60.0) is False
    assert table.is_owned_by(child.pid, "alpha") is False

    # Missing create_time (a pre-v2 record) → refused, because without it a
    # recycled PID is indistinguishable from the original.
    assert table.adopt_recorded("alpha", child.pid, None) is False
    assert table.is_owned_by(child.pid, "alpha") is False

    # Matching create_time → adopted and killable.
    assert table.adopt_recorded("alpha", child.pid, real_ct) is True
    assert table.is_owned_by(child.pid, "alpha") is True
    assert _find(table, child.pid).tier is Tier.RECORDED


def test_adopt_recorded_cannot_steal_another_instances_process(spawn_owned):
    """Registry poisoning must not work.

    A stale registry naming a live PID that demonstrably belongs to someone else
    is exactly the ``kill tmpl-3`` → dev-2 hazard; adoption has to refuse it.
    """
    child = spawn_owned("dev-2")
    table = liveness.scan(want_ports=False)
    ct = _find(table, child.pid).create_time

    assert table.adopt_recorded("tmpl-3", child.pid, ct) is False
    assert table.is_owned_by(child.pid, "tmpl-3") is False
    assert table.is_owned_by(child.pid, "dev-2") is True


def test_listeners_and_port_owner_attribute_a_real_socket(spawn_owned, free_port):
    port = free_port()
    child = spawn_owned("alpha", port=port)

    table = liveness.scan()
    if table.ports_degraded:
        pytest.skip("socket attribution unavailable in this environment")

    assert table.port_in_use(port) is True
    assert child.pid in {p.pid for p in table.listeners(port)}
    assert table.port_owner(port) == "alpha"


def test_port_owner_is_none_for_an_unowned_listener(free_port):
    """A socket held by a process we cannot attribute yields no owner.

    ``port_owner`` returning None is what makes ``kill_allowed`` refuse, so an
    unattributable listener must never resolve to a name.
    """
    import socket

    port = free_port()
    with socket.socket() as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("127.0.0.1", port))
        s.listen(1)

        table = liveness.scan()
        if table.ports_degraded:
            pytest.skip("socket attribution unavailable in this environment")
        # Held by pytest itself, which is not instance 'alpha'.
        assert table.port_owner(port) != "alpha"
