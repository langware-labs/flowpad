"""The launcher registry, the env renderer, and the name guard.

``launcher.json`` is a public contract with roughly a dozen independent readers
across ``ui/tests/{hub,headless,react,api,long_tests}``, two shell scripts, a
report script and ``flow instance restart-backend``. It may grow keys but may
never rename or retype one, so the flat v1 mirrors are asserted explicitly here
rather than left to integration to discover.
"""

from __future__ import annotations

import json

import pytest

from flow_sdk.instances import env, paths, registry
from flow_sdk.instances.errors import NameInvalid
from flow_sdk.instances.model import (
    InstanceKind,
    LauncherRecord,
    ProcRef,
    Role,
)

pytestmark = pytest.mark.usefixtures("instances_home")


def _full(name="dev-1", group=None, **kw) -> LauncherRecord:
    return LauncherRecord(
        name=name,
        group=group or name,
        kind=kw.pop("kind", InstanceKind.FULL),
        hub_url=kw.pop("hub_url", "http://localhost:8093"),
        email=kw.pop("email", env.default_email(name)),
        env_file=str(paths.env_file(name)),
        repo_root=str(paths.repo_root()),
        backend=kw.pop("backend", ProcRef(pid=111, port=6001, create_time=1.0)),
        frontend=kw.pop("frontend", ProcRef(pid=222, port=5002, create_time=2.0)),
        **kw,
    )


# ── the v1 contract ──────────────────────────────────────────────────────────
def test_full_record_emits_every_v1_mirror_key():
    """The keys ~12 external readers index into, asserted by name."""
    registry.write(_full())
    d = json.loads(paths.launcher_path("dev-1").read_text())

    assert d["name"] == "dev-1"
    assert d["backend_port"] == 6001
    assert d["frontend_port"] == 5002
    assert d["backend_pid"] == 111
    assert d["frontend_pid"] == 222
    assert d["hub_url"] == "http://localhost:8093"
    assert d["email"] == "dev-1@local.test"
    assert d["env_file"] == str(paths.env_file("dev-1"))
    assert "backend_log" in d and "frontend_log" in d


def test_env_file_in_the_registry_is_absolute_and_matches_the_repo_root():
    """``ui/tests/hub/_instances.ts`` requires
    ``path.resolve(env_file) === <root>/.env.<name>.local`` and skips the whole
    suite otherwise — a silent skip that reads as a pass."""
    registry.write(_full())
    d = json.loads(paths.launcher_path("dev-1").read_text())
    p = paths.repo_root() / ".env.dev-1.local"
    assert d["env_file"] == str(p)
    assert p.is_absolute()


def test_v1_registry_reads_as_a_full_instance_grouped_under_itself():
    """Files written before this refactor have no kind or group."""
    d = paths.instance_dir("legacy-3")
    d.mkdir(parents=True)
    (d / "launcher.json").write_text(json.dumps({
        "name": "legacy-3", "frontend_port": 5003, "backend_port": 6003,
        "hub_url": "http://localhost:8093", "email": "legacy-3@local.test",
        "env_file": str(paths.env_file("legacy-3")),
        "backend_pid": 900, "frontend_pid": 901,
        "backend_log": "/tmp/be.log", "frontend_log": "/tmp/fe.log",
    }))

    rec = registry.read("legacy-3")
    assert rec.kind is InstanceKind.FULL
    assert rec.group == "legacy-3"
    assert rec.schema_version == 1
    assert rec.backend.port == 6003
    assert rec.backend.pid == 900
    assert rec.frontend.port == 5003
    # A v1 record has no create_time, which is exactly why it cannot be adopted
    # by pid alone — see test_instance_liveness.
    assert rec.backend.create_time is None


def test_round_trip_preserves_everything():
    registry.write(_full(name="qa25-1", group="qa25"))
    rec = registry.read("qa25-1")
    assert rec.name == "qa25-1"
    assert rec.group == "qa25"
    assert rec.backend == ProcRef(pid=111, port=6001, create_time=1.0)
    assert rec.frontend == ProcRef(pid=222, port=5002, create_time=2.0)


def test_a_registry_disagreeing_with_its_directory_trusts_the_directory():
    d = paths.instance_dir("real-1")
    d.mkdir(parents=True)
    (d / "launcher.json").write_text(json.dumps({"name": "someone-else"}))
    assert registry.read("real-1").name == "real-1"


# ── hub-ui shape ─────────────────────────────────────────────────────────────
def test_hub_ui_registry_fails_the_desk_instance_gate_structurally():
    """A hub-ui instance must be *unable* to be adopted as a desk instance.

    ``ui/tests/hub/_instances.ts`` requires an integer ``backend_port`` and a
    live ``backend_pid``. Emitting ``null`` and omitting the pid makes those
    checks reject it by data shape, so the rejection cannot rot into a
    convention someone later "fixes".
    """
    rec = LauncherRecord(
        name="qa25-hub", group="qa25", kind=InstanceKind.HUB_UI,
        hub_url="http://localhost:8093", email="qa25-hub@local.test",
        env_file=str(paths.env_file("qa25-hub")),
        frontend=ProcRef(pid=333, port=5025, create_time=3.0),
    )
    registry.write(rec)
    d = json.loads(paths.launcher_path("qa25-hub").read_text())

    assert d["kind"] == "hub-ui"
    assert d["backend_port"] is None
    assert "backend_pid" not in d
    assert d["frontend_port"] == 5025
    assert d["frontend_pid"] == 333

    back = registry.read("qa25-hub")
    assert back.kind is InstanceKind.HUB_UI
    assert back.roles == frozenset({Role.FRONTEND})
    assert back.ref(Role.BACKEND) is None
    assert back.ref(Role.FRONTEND).port == 5025


# ── groups ───────────────────────────────────────────────────────────────────
def test_groups_are_derived_from_the_records_alone():
    """No groups.json: a second file describing the same relationship is a
    second source of truth, and drift there is the whole bug class."""
    for name in ("qa25-hub", "qa25-a", "qa25-b"):
        registry.write(_full(name=name, group="qa25"))
    registry.write(_full(name="dev-1"))

    groups = registry.groups()
    assert set(groups) == {"qa25", "dev-1"}
    assert [r.name for r in groups["qa25"]] == ["qa25-a", "qa25-b", "qa25-hub"]
    assert [r.name for r in groups["dev-1"]] == ["dev-1"]
    assert [r.name for r in registry.members_of("qa25")] == [
        "qa25-a", "qa25-b", "qa25-hub"
    ]


def test_members_of_an_unknown_group_is_empty_not_an_error():
    assert registry.members_of("no-such-group") == []


# ── enumeration ──────────────────────────────────────────────────────────────
def test_all_known_names_unions_dirs_and_env_files():
    """The sweep must see instances with no registry.

    On the machine that prompted this work there were 286 instance directories
    and 36 registries — a registry-driven sweep would have missed 250 of them.
    """
    paths.instance_dir("dir-only-7").mkdir(parents=True)
    paths.env_file("env-only-8").write_text("FLOW_INSTANCE=env-only-8\n")
    registry.write(_full(name="registered-9"))

    names = registry.all_known_names()
    assert {"dir-only-7", "env-only-8", "registered-9"} <= names


def test_non_instance_siblings_are_never_enumerated():
    """``global`` and ``capability-installs`` live under instances/ but are not
    instances — a sweep that treated them as such would delete shared state."""
    (paths.instances_root() / "global").mkdir(parents=True)
    (paths.instances_root() / "capability-installs").mkdir(parents=True)
    registry.write(_full(name="real-1"))

    assert [d.name for d in paths.known_instance_dirs()] == ["real-1"]
    assert "global" not in registry.all_known_names()
    assert "capability-installs" not in registry.all_known_names()


def test_an_illegally_named_directory_is_never_a_sweep_target():
    (paths.instances_root() / "--help").mkdir(parents=True)
    (paths.instances_root() / "UPPER").mkdir(parents=True)
    assert [d.name for d in paths.known_instance_dirs()] == []


# ── the name guard ───────────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "bad",
    ["", ".", "..", "../../etc", "a/b", "-x", "*", " ", "dev-1 dev-2",
     "UPPER", "x" * 300, "/abs", "a\\b", "a\nb"],
)
def test_illegal_names_are_rejected_before_any_path_is_derived(bad):
    """This is the traversal guard, not a cosmetic check.

    ``dev-1 dev-2`` matters specifically: the bash launcher split its protected
    list on whitespace, so a name containing a space could smuggle a second
    token past the protection check.
    """
    with pytest.raises(NameInvalid):
        paths.validate_name(bad)
    with pytest.raises(NameInvalid):
        paths.instance_dir(bad)
    with pytest.raises(NameInvalid):
        paths.env_file(bad)


@pytest.mark.parametrize("good", ["dev-1", "qa25-hub", "oss", "a", "a.b_c-1"])
def test_legal_names_resolve_inside_the_instances_root(good):
    d = paths.instance_dir(good)
    assert d.parent == paths.instances_root()
    assert paths.env_file(good).parent == paths.repo_root()


def test_protected_instances_default_and_override(monkeypatch):
    monkeypatch.delenv("PROTECTED_INSTANCES", raising=False)
    assert paths.protected_instances() == frozenset({"prod", "oss", "dev-1", "dev-2"})

    monkeypatch.setenv("PROTECTED_INSTANCES", "alpha  beta")
    assert paths.protected_instances() == frozenset({"alpha", "beta"})


# ── env rendering ────────────────────────────────────────────────────────────
def test_full_env_file_shape(monkeypatch):
    monkeypatch.delenv("E2B_KEY", raising=False)
    rec = _full(name="dev-1")
    text = env.render(rec, password=env.default_password("dev-1"))
    vals = dict(
        line.split("=", 1) for line in text.splitlines() if "=" in line and line[0] != "#"
    )

    assert vals["FLOW_INSTANCE"] == "dev-1"
    assert vals["LOCAL_SERVER_PORT"] == "6001"
    assert vals["VITE_PORT"] == "5002"
    assert vals["VITE_API_URL"] == "http://localhost:6001"
    assert vals["FLOWPAD_HUB_URL"] == "http://localhost:8093"
    assert vals["FLOWPAD_CLOUD_USER_EMAIL"] == "dev-1@local.test"
    assert vals["FLOWPAD_CLOUD_USER_PASSWORD"] == "dev-1-pw-1234"
    # Both are load-bearing, not tuning: MINIHUB_RELOAD keeps the backend
    # single-process so a PID kill suffices, and FLOWPAD_SKIP_DOTENV stops
    # run.py's load_dotenv(override=True) from clobbering the injected ports.
    assert vals["MINIHUB_RELOAD"] == "False"
    assert vals["FLOWPAD_SKIP_DOTENV"] == "true"
    assert "VITE_FORCE_HUB" not in vals


def test_hub_ui_env_omits_local_server_port_and_points_at_the_hub():
    """The omission is the mechanism that makes the desk harness reject it:
    ``_instances.ts`` requires ``/^\\d+$/.test(LOCAL_SERVER_PORT)``."""
    rec = LauncherRecord(
        name="qa25-hub", group="qa25", kind=InstanceKind.HUB_UI,
        hub_url="https://hub.example", email="qa25-hub@local.test",
        frontend=ProcRef(pid=1, port=5025),
    )
    text = env.render(rec, password="pw")
    vals = dict(
        line.split("=", 1) for line in text.splitlines() if "=" in line and line[0] != "#"
    )

    assert "LOCAL_SERVER_PORT" not in vals
    assert "MINIHUB_RELOAD" not in vals
    assert "FLOWPAD_SKIP_DOTENV" not in vals
    assert "E2B_KEY" not in vals
    assert vals["VITE_API_URL"] == "https://hub.example"
    assert vals["VITE_FORCE_HUB"] == "true"
    assert vals["VITE_PORT"] == "5025"
    # Still stamped, even though the browser never reads it: it is the only
    # handle that makes the vite process reapable by instance name.
    assert vals["FLOW_INSTANCE"] == "qa25-hub"


def test_e2b_key_is_carried_across_the_skip_dotenv_boundary(monkeypatch):
    """The isolated backend skips the repo dotenv, so an exported credential
    has to be written through or a QA instance silently loses sandbox access."""
    monkeypatch.setenv("E2B_KEY", "secret-value")
    text = env.render(_full(), password="pw")
    assert "E2B_KEY=secret-value" in text


def test_env_file_write_read_delete_round_trip():
    rec = _full(name="dev-1")
    env.write_env_file(rec, password="dev-1-pw-1234")
    assert paths.env_file("dev-1").exists()

    vals = env.read_env_file("dev-1")
    assert vals["FLOW_INSTANCE"] == "dev-1"
    assert vals["LOCAL_SERVER_PORT"] == "6001"

    assert env.delete_env_file("dev-1") is True
    assert env.read_env_file("dev-1") == {}
    assert env.delete_env_file("dev-1") is False
