"""Status resolution, rendering, and the machine-readable surfaces.

The headline assertion is ``test_a_stale_registry_does_not_report_up_because_a
_stranger_holds_its_port``: the launcher this replaces printed ``[UP]`` from
port occupancy alone, so on a real machine four registries claiming :5007 all
reported up while a single unrelated vite was the only live process.
"""

from __future__ import annotations

import json

import pytest

from flow_sdk.instances import manager, paths, registry, render
from flow_sdk.instances.errors import NoSuchRole, UnknownInstance
from flow_sdk.instances.model import (
    InstanceKind,
    InstanceState,
    LauncherRecord,
    ProcRef,
    Role,
)
from flow_sdk.instances.ports import PortLedger

pytestmark = pytest.mark.usefixtures("instances_home")


def _record(name, *, group=None, kind=InstanceKind.FULL, be=None, fe=None):
    rec = LauncherRecord(
        name=name, group=group or name, kind=kind,
        hub_url="http://localhost:8093", email=f"{name}@local.test",
        env_file=str(paths.env_file(name)), repo_root=str(paths.repo_root()),
        backend=be or ProcRef(), frontend=fe or ProcRef(),
    )
    registry.write(rec)
    return rec


def _live_ref(proc, port=None):
    import psutil

    return ProcRef(pid=proc.pid, port=port, create_time=psutil.Process(proc.pid).create_time())


# ── the core lie this refactor removes ───────────────────────────────────────
def test_a_stale_registry_does_not_report_up_because_a_stranger_holds_its_port(
    spawn_owned, free_port
):
    port = free_port()
    live = spawn_owned("dev-2", port=port)
    _record("dev-2", fe=_live_ref(live, port))
    # tmpl-3 died long ago; its registry still records the port dev-2 now holds.
    _record("tmpl-3", fe=ProcRef(pid=999_999, port=port))

    report = manager.status(["dev-2", "tmpl-3"])
    by_name = {i.name: i for i in report.instances}

    assert by_name["dev-2"].frontend.owned is True
    assert by_name["tmpl-3"].frontend.owned is False
    assert by_name["tmpl-3"].state is not InstanceState.RUNNING
    assert manager.is_up("tmpl-3") is False
    assert manager.is_up("dev-2", Role.FRONTEND) is True


def test_a_conflicting_lease_is_surfaced_not_absorbed(spawn_owned, free_port):
    port = free_port()
    spawn_owned("dev-2", port=port)
    with PortLedger.open() as ledger:
        ledger.record(port, "tmpl-3", Role.FRONTEND)
    _record("tmpl-3", fe=ProcRef(pid=999_999, port=port))

    report = manager.status()
    if report.ports_degraded:
        pytest.skip("socket attribution unavailable in this environment")

    assert [c.port for c in report.conflicts] == [port]
    tmpl = next(i for i in report.instances if i.name == "tmpl-3")
    # Carried on the instance AND on the report, from one computation — the
    # conflict used to also be an InstanceState, which meant a RUNNING instance
    # whose port had been taken showed no conflict at all in its state.
    assert [c.port for c in tmpl.conflicts] == [port]
    assert any("held by" in w for w in tmpl.warnings)


# ── states ───────────────────────────────────────────────────────────────────
def test_running_requires_every_role_of_the_kind(spawn_owned):
    be, fe = spawn_owned("dev-1"), spawn_owned("dev-1")
    _record("dev-1", be=_live_ref(be), fe=_live_ref(fe))
    assert manager.resolve("dev-1").state is InstanceState.RUNNING
    assert manager.is_up("dev-1") is True


def test_a_live_frontend_with_a_dead_backend_is_degraded(spawn_owned):
    """The exact shape of every leftover on the machine that motivated this:
    the backend exits, nothing links the two lifetimes, the vite runs for days."""
    fe = spawn_owned("dev-1")
    _record("dev-1", be=ProcRef(pid=999_999, port=6001), fe=_live_ref(fe))

    st = manager.resolve("dev-1")
    assert st.state is InstanceState.DEGRADED
    assert st.backend.alive is False
    assert st.frontend.owned is True
    assert manager.is_up("dev-1") is False
    assert manager.is_up("dev-1", Role.FRONTEND) is True


def test_no_live_processes_is_stale():
    _record("dev-1", be=ProcRef(pid=999_999, port=6001))
    assert manager.resolve("dev-1").state is InstanceState.STALE


def test_live_processes_without_a_registry_are_orphaned(spawn_owned):
    spawn_owned("ghosty-9")
    st = manager.resolve("ghosty-9")
    assert st.state is InstanceState.ORPHANED
    # An orphan is explicitly NOT "up": nothing about it has been verified.
    assert manager.is_up("ghosty-9") is False


def test_a_never_allocated_name_is_unknown_not_an_error():
    st = manager.resolve("never-allocated-xyz")
    assert st.state is InstanceState.UNKNOWN
    assert st.warnings == ("never allocated",)
    assert manager.is_up("never-allocated-xyz") is False


def test_a_self_managed_backend_is_running_not_orphaned(spawn_owned, free_port):
    """`oss`/`prod` are started by hand and never get a launcher.json.

    Their backend picks FLOW_INSTANCE up from `.env.local` via dotenv INSIDE the
    process, so `environ()` never shows it — only `server.json` vouches for the
    PID. Calling such an instance an orphan would invite reaping a developer's
    working backend and every worker under it.
    """
    port = free_port()
    proc = spawn_owned("selfmanaged", port=port, env_instance=False)
    d = paths.instance_dir("selfmanaged")
    d.mkdir(parents=True)
    (d / "server.json").write_text(json.dumps({"port": port, "server_pid": proc.pid}))

    report = manager.status(["selfmanaged"])
    st = report.instances[0]
    if st.backend.port is None:
        pytest.skip("socket attribution unavailable in this environment")

    assert st.state is InstanceState.RUNNING
    assert st.backend.owned is True
    # A first-class field, not a warning substring: kill/reset/teardown all
    # need the predicate and matching prose for it is fragile both ways.
    assert st.launcher_owned is False
    # And its processes must not be offered up for reaping.
    assert [o.instance for o in report.orphans] == []


def test_a_stale_server_json_is_reported_as_a_broadcast_hazard():
    """A SIGKILLed backend leaves server.json behind; `flow hooks report`
    POSTs to every one, so a stale file on a recycled port delivers hook
    payloads into a different live instance."""
    d = paths.instance_dir("crashed-4")
    d.mkdir(parents=True)
    (d / "server.json").write_text(json.dumps({"port": 6004, "server_pid": 999_999}))

    st = manager.resolve("crashed-4")
    assert st.state is InstanceState.STALE
    assert any("stale server.json" in w for w in st.warnings)


# ── kinds ────────────────────────────────────────────────────────────────────
def test_a_hub_ui_instance_with_no_backend_is_running_not_half_broken(spawn_owned):
    fe = spawn_owned("qa25-hub")
    _record("qa25-hub", group="qa25", kind=InstanceKind.HUB_UI, fe=_live_ref(fe))

    st = manager.resolve("qa25-hub")
    assert st.state is InstanceState.RUNNING
    assert st.backend.applicable is False   # "—", never "down"
    assert st.frontend.owned is True
    assert manager.is_up("qa25-hub") is True


def test_port_for_a_role_the_kind_lacks_is_a_typed_refusal(spawn_owned):
    fe = spawn_owned("qa25-hub")
    _record("qa25-hub", kind=InstanceKind.HUB_UI, fe=_live_ref(fe, 5025))

    with pytest.raises(NoSuchRole):
        manager.port_of("qa25-hub", Role.BACKEND)


def test_port_of_an_unallocated_instance_raises_rather_than_guessing():
    with pytest.raises(UnknownInstance):
        manager.port_of("never-allocated-xyz", Role.BACKEND)


def test_port_never_comes_from_the_ledger_alone():
    """A lease records intent. Returning it as a live port is how a caller ends
    up talking to whatever recycled that port."""
    with PortLedger.open() as ledger:
        ledger.record(6001, "dev-1", Role.BACKEND)
    _record("dev-1", be=ProcRef(pid=999_999, port=6001))

    with pytest.raises(UnknownInstance):
        manager.port_of("dev-1", Role.BACKEND)


# ── grouping + filtering ─────────────────────────────────────────────────────
def test_groups_hold_only_multi_member_groups(spawn_owned):
    for n in ("qa25-a", "qa25-b"):
        _record(n, group="qa25", fe=_live_ref(spawn_owned(n)))
    _record("solo-1", fe=_live_ref(spawn_owned("solo-1")))

    report = manager.status()
    assert list(report.groups()) == ["qa25"]
    assert [i.name for i in report.groups()["qa25"]] == ["qa25-a", "qa25-b"]
    # A group of one is just an instance; it renders in the flat table.
    assert "solo-1" in {i.name for i in report.ungrouped()}


def test_group_filter_selects_exactly_its_members(spawn_owned):
    for n in ("qa25-a", "qa25-b"):
        _record(n, group="qa25", fe=_live_ref(spawn_owned(n)))
    _record("other-1", fe=_live_ref(spawn_owned("other-1")))

    report = manager.status(group="qa25")
    assert sorted(i.name for i in report.instances) == ["qa25-a", "qa25-b"]


def test_an_unknown_group_yields_an_empty_report_not_an_error():
    report = manager.status(group="no-such-group")
    assert report.instances == ()


def test_stale_instances_are_hidden_by_default_and_counted(spawn_owned):
    """281 leftovers must not bury the rows anyone cares about.

    Asserted as a subset, not an exact list: an unnamed ``status()`` also
    enumerates live processes machine-wide, which is deliberate — that is how an
    orphan whose directory is long gone still shows up — so the developer's own
    running instances legitimately appear alongside this test's fixtures.
    """
    dead = {f"dead-{i}" for i in range(5)}
    for i, name in enumerate(sorted(dead)):
        _record(name, be=ProcRef(pid=999_990 + i, port=6000 + i))
    _record("dev-1x", fe=_live_ref(spawn_owned("dev-1x")))

    default = manager.status()
    shown = {i.name for i in default.instances}
    assert "dev-1x" in shown
    assert shown.isdisjoint(dead)
    assert default.hidden >= len(dead)

    everything = manager.status(all_=True)
    shown_all = {i.name for i in everything.instances}
    assert dead <= shown_all
    assert "dev-1x" in shown_all
    assert everything.hidden == 0


def test_an_explicitly_named_stale_instance_is_always_shown():
    _record("dead-1", be=ProcRef(pid=999_999, port=6001))
    report = manager.status(["dead-1"])
    assert [i.name for i in report.instances] == ["dead-1"]
    assert report.hidden == 0


# ── rendering ────────────────────────────────────────────────────────────────
def test_plain_output_has_no_ansi_escapes(spawn_owned):
    _record("dev-1", fe=_live_ref(spawn_owned("dev-1")))
    text = render.render(manager.status(), "plain")
    assert "\033" not in text
    assert "dev-1" in text


def test_the_glyph_distinguishes_verified_from_unverifiable(spawn_owned):
    """`●` vs `◐` is what makes the four-registries-all-UP lie unrepresentable."""
    fe = spawn_owned("dev-1")
    _record("dev-1", be=ProcRef(pid=999_999, port=6001), fe=_live_ref(fe))
    text = render.render(manager.status(), "plain")

    assert render.LIVE in text     # the owned frontend
    assert render.DEAD in text     # the dead recorded backend


def test_hub_ui_renders_a_dash_for_its_absent_backend(spawn_owned):
    _record("qa25-hub", kind=InstanceKind.HUB_UI, fe=_live_ref(spawn_owned("qa25-hub")))
    text = render.render(manager.status(), "plain")
    assert render.NA in text


def test_rich_export_is_stable_and_contains_the_rows(spawn_owned):
    _record("dev-1", fe=_live_ref(spawn_owned("dev-1")))
    text = render.render(manager.status(), "rich")
    assert "dev-1" in text
    assert "Flowpad instances" in text


def test_json_report_shape(spawn_owned):
    fe = spawn_owned("qa25-a")
    _record("qa25-a", group="qa25", fe=_live_ref(fe, 5025))
    _record("qa25-b", group="qa25", fe=_live_ref(spawn_owned("qa25-b")))

    doc = json.loads(render.render(manager.status(), "json"))
    assert doc["schema_version"] == 1
    assert set(doc) >= {
        "generated_at", "flow_home", "repo_root", "protected", "ports_degraded",
        "hidden", "groups", "instances", "orphans", "port_conflicts",
    }
    grp = next(g for g in doc["groups"] if g["name"] == "qa25")
    assert sorted(grp["members"]) == ["qa25-a", "qa25-b"]
    assert grp["total"] == 2

    inst = next(i for i in doc["instances"] if i["name"] == "qa25-a")
    assert set(inst) >= {
        "name", "group", "kind", "state", "backend", "frontend", "warnings",
    }
    assert set(inst["backend"]) >= {
        "applicable", "port", "pid", "alive", "owned", "tier", "listening",
    }


def test_orphans_appear_in_the_report_with_a_next_step(spawn_owned):
    spawn_owned("ghosty-9")
    report = manager.status()
    assert "ghosty-9" in {o.instance for o in report.orphans}
    assert "reap" in render.render(report, "plain")


def test_format_defaults_to_plain_when_piped(monkeypatch):
    monkeypatch.setattr("sys.stdout.isatty", lambda: False, raising=False)
    assert render.resolve_format(None) == "plain"


def test_format_honors_no_color(monkeypatch):
    monkeypatch.setattr("sys.stdout.isatty", lambda: True, raising=False)
    monkeypatch.setenv("NO_COLOR", "1")
    assert render.resolve_format(None) == "plain"
