"""The port ledger.

Two of these are direct regression tests for bugs in the bash launcher:

* ``test_non_numeric_names_get_distinct_ports`` — ``name_index`` falls back to 1
  for any name without trailing digits, so ``qa-cycle``/``oss``/``gitconn`` all
  preferred the same port and only a momentary ``lsof`` separated them. On the
  real machine that produced three registries claiming backend 6001.
* ``test_allocate_is_sticky_across_relaunch`` — the launcher killed and then
  re-derived the port from scratch, so a relaunch could silently move a
  backend. Two api restart tests cache ``LOCAL_SERVER_PORT`` *before*
  relaunching, so a moved port makes them talk to nothing until they time out.
"""

from __future__ import annotations

import json

import pytest

from flow_sdk.instances import liveness, paths
from flow_sdk.instances.errors import PortExhausted
from flow_sdk.instances.model import Role
from flow_sdk.instances.ports import (
    BACKEND_BASE,
    BAND_SPAN,
    FRONTEND_BASE,
    RESERVED_PORTS,
    PortLedger,
    kill_allowed,
    name_index,
    preferred_port,
)

pytestmark = pytest.mark.usefixtures("instances_home")


@pytest.fixture
def empty_table():
    """A process table with nothing in it — allocation sees every port as free."""
    return liveness.ProcTable()


# ── allocation ───────────────────────────────────────────────────────────────
def test_name_index_falls_back_to_one():
    assert name_index("dev-1") == 1
    assert name_index("qa25-12") == 12
    assert name_index("qa-cycle") == 1
    assert name_index("oss") == 1
    assert preferred_port("dev-1", Role.BACKEND) == 6001
    assert preferred_port("dev-1", Role.FRONTEND) == 5001


def test_non_numeric_names_get_distinct_ports(empty_table):
    """REGRESSION: three names that all prefer index 1 must not collide."""
    ledger = PortLedger()
    ports = {
        name: ledger.allocate(name, Role.BACKEND, empty_table)
        for name in ("qa-cycle", "oss", "gitconn")
    }
    assert len(set(ports.values())) == 3, ports


def test_reserved_ports_are_never_allocated(empty_table):
    ledger = PortLedger()
    allocated = set()
    for i in range(30):
        name = f"inst-{i}"
        allocated.add(ledger.allocate(name, Role.FRONTEND, empty_table))
        allocated.add(ledger.allocate(name, Role.BACKEND, empty_table))
    assert allocated.isdisjoint(RESERVED_PORTS)
    assert 5000 not in allocated  # macOS AirPlay
    assert 5001 not in allocated  # neo4j
    assert 6000 not in allocated  # ERR_UNSAFE_PORT


def test_allocate_is_sticky_across_relaunch(empty_table):
    """REGRESSION: an instance's port must survive a relaunch unchanged."""
    ledger = PortLedger()
    first = ledger.allocate("qa-cycle", Role.BACKEND, empty_table)
    for _ in range(3):
        assert ledger.allocate("qa-cycle", Role.BACKEND, empty_table) == first


def test_sticky_reuse_survives_a_reload_from_disk(empty_table):
    """Stickiness has to come from the persisted ledger, not in-memory state —
    each CLI invocation is a fresh process."""
    ledger = PortLedger()
    first = ledger.allocate("qa-cycle", Role.BACKEND, empty_table)
    ledger.save()

    reloaded = PortLedger.load()
    assert reloaded.allocate("qa-cycle", Role.BACKEND, empty_table) == first


def test_roles_get_ports_from_their_own_band(empty_table):
    ledger = PortLedger()
    fe = ledger.allocate("dev-4", Role.FRONTEND, empty_table)
    be = ledger.allocate("dev-4", Role.BACKEND, empty_table)
    assert FRONTEND_BASE < fe <= FRONTEND_BASE + BAND_SPAN
    assert BACKEND_BASE < be <= BACKEND_BASE + BAND_SPAN


def test_a_live_leaseholder_keeps_its_port(spawn_owned, empty_table):
    """A port leased to an instance that still has a live process is not
    re-handed to someone else — otherwise a booting backend gets robbed."""
    ledger = PortLedger()
    held = ledger.allocate("dev-1", Role.BACKEND, empty_table)
    spawn_owned("dev-1")

    table = liveness.scan(want_ports=False)
    other = ledger.allocate("dev-1x", Role.BACKEND, table)
    assert other != held


def test_release_frees_the_port_for_another_instance(empty_table):
    ledger = PortLedger()
    held = ledger.allocate("dev-1", Role.BACKEND, empty_table)
    assert ledger.release("dev-1") == [held]
    assert ledger.lease_for("dev-1", Role.BACKEND) is None
    assert ledger.allocate("other-1", Role.BACKEND, empty_table) == held


def test_port_exhaustion_raises_rather_than_returning_garbage(empty_table):
    """A full band must fail loudly, not silently hand back a port in use."""
    ledger = PortLedger()
    for port in range(BACKEND_BASE + 1, BACKEND_BASE + BAND_SPAN + 1):
        ledger.record(port, f"filler{port}", Role.BACKEND)
    with pytest.raises(PortExhausted):
        ledger.allocate("newcomer-1", Role.BACKEND, empty_table)


# ── persistence ──────────────────────────────────────────────────────────────
def test_ledger_round_trips(empty_table):
    ledger = PortLedger()
    be = ledger.allocate("dev-1", Role.BACKEND, empty_table)
    fe = ledger.allocate("dev-1", Role.FRONTEND, empty_table)
    ledger.save()

    reloaded = PortLedger.load()
    assert reloaded.lease_for("dev-1", Role.BACKEND).port == be
    assert reloaded.lease_for("dev-1", Role.FRONTEND).port == fe
    assert reloaded.ports_of("dev-1") == {be, fe}


def test_corrupt_ledger_degrades_to_empty_rather_than_wedging(empty_table):
    """A truncated ledger must not make every command fail — allocation is how
    you recover, so it has to keep working."""
    paths.ports_ledger_path().write_text("{not json at all")
    ledger = PortLedger.load()
    assert ledger.leases == {}
    assert ledger.allocate("dev-1", Role.BACKEND, empty_table)


def test_garbage_lease_rows_are_dropped_not_trusted(empty_table):
    paths.ports_ledger_path().write_text(json.dumps({
        "schema_version": 1,
        "leases": {
            "6001": {"instance": "dev-1", "role": "backend"},
            "notaport": {"instance": "x", "role": "backend"},
            "6002": {"role": "backend"},              # no instance
            "6003": {"instance": "y", "role": "bogus"},  # unknown role
        },
    }))
    ledger = PortLedger.load()
    assert set(ledger.leases) == {6001}


def test_open_holds_the_lock_and_persists(empty_table):
    with PortLedger.open() as ledger:
        port = ledger.allocate("dev-1", Role.BACKEND, empty_table)
    assert PortLedger.load().lease_for("dev-1", Role.BACKEND).port == port


def test_concurrent_allocation_never_double_assigns(instances_home):
    """Eight real processes allocating at once must produce eight ports."""
    import subprocess
    import sys

    code = (
        "import json, sys\n"
        "from flow_sdk.instances import paths\n"
        "from flow_sdk.instances.liveness import ProcTable\n"
        "from flow_sdk.instances.ports import PortLedger\n"
        "from flow_sdk.instances.model import Role\n"
        f"paths.REPO_ROOT = __import__('pathlib').Path({str(instances_home.repo)!r})\n"
        "with PortLedger.open() as led:\n"
        "    print(led.allocate(sys.argv[1], Role.BACKEND, ProcTable()))\n"
    )
    procs = [
        subprocess.Popen(
            [sys.executable, "-c", code, f"conc-{i}"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        for i in range(8)
    ]
    ports = []
    for p in procs:
        out, err = p.communicate()
        assert p.returncode == 0, err
        ports.append(int(out.strip()))
    assert len(set(ports)) == 8, ports


# ── reconciliation + conflicts ───────────────────────────────────────────────
def test_reconcile_drops_a_lease_with_no_trace_of_its_holder(empty_table):
    ledger = PortLedger()
    port = ledger.allocate("ghost-9", Role.BACKEND, empty_table)
    assert ledger.reconcile(liveness.ProcTable()) == [port]
    assert ledger.leases == {}


def test_reconcile_keeps_a_lease_whose_holder_is_alive(spawn_owned, empty_table):
    """A backend that is still booting holds no socket yet; dropping its lease
    mid-launch would hand its port to the next allocator."""
    ledger = PortLedger()
    port = ledger.allocate("dev-1", Role.BACKEND, empty_table)
    spawn_owned("dev-1")

    table = liveness.scan(want_ports=False)
    assert ledger.reconcile(table) == []
    assert port in ledger.leases


def test_a_stranger_on_a_leased_port_is_a_conflict_not_a_silent_drop(
    spawn_owned, free_port
):
    """The dev-2/tmpl-3 collision, surfaced instead of acted upon."""
    port = free_port()
    ledger = PortLedger()
    ledger.record(port, "tmpl-3", Role.FRONTEND)
    spawn_owned("dev-2", port=port)

    table = liveness.scan()
    if table.ports_degraded:
        pytest.skip("socket attribution unavailable in this environment")

    assert ledger.reconcile(table) == []
    assert port in ledger.leases

    conflicts = ledger.conflicts(table)
    assert [c.port for c in conflicts] == [port]
    assert conflicts[0].leased_to == "tmpl-3"
    assert conflicts[0].held_by == "dev-2"


# ── the kill gate ────────────────────────────────────────────────────────────
def test_kill_allowed_is_true_only_for_your_own_listener(spawn_owned, free_port):
    port = free_port()
    spawn_owned("dev-2", port=port)

    table = liveness.scan()
    if table.ports_degraded:
        pytest.skip("socket attribution unavailable in this environment")

    assert kill_allowed(port, "dev-2", table) is True
    # THE regression: a stale registry recording this port must not authorize
    # a kill just because it recorded it.
    assert kill_allowed(port, "tmpl-3", table) is False


def test_kill_allowed_is_false_for_an_empty_port(free_port):
    table = liveness.scan()
    assert kill_allowed(free_port(), "dev-1", table) is False


def test_kill_allowed_refuses_when_socket_attribution_is_degraded(free_port):
    """No evidence must mean no kill — guessing here is what made kill unsafe."""
    table = liveness.ProcTable()
    table.ports_degraded = True
    assert kill_allowed(free_port(), "dev-1", table) is False
