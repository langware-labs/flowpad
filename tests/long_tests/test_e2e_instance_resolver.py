"""Narrow contract tests for the long-suite live-instance resolver."""

import os
from dataclasses import FrozenInstanceError, replace

import pytest

from flow_sdk.instances.model import (
    InstanceKind,
    InstanceState,
    InstanceStatus,
    LauncherRecord,
    ProcRef,
    Role,
    RoleStatus,
    Tier,
)
from tests.long_tests.conftest import LiveE2EInstance
from tests.long_tests.test_ws_reconnect_message_catchup import _local_hub_for_pair


@pytest.fixture()
def resolver_state(monkeypatch, tmp_path):
    from flow_sdk.instances import atomic, env, manager, paths, registry

    name = "qacycle-6"
    port = 6106
    pid = 41006
    expected_flow_home = tmp_path / "real-home" / ".flow"
    env_file = tmp_path / "repo" / f".env.{name}.local"
    backend = RoleStatus(
        role=Role.BACKEND,
        applicable=True,
        port=port,
        pid=pid,
        alive=True,
        owned=True,
        tier=Tier.ENV,
        listening=True,
    )
    state = {
        "status": InstanceStatus(
            name=name,
            group=name,
            kind=InstanceKind.FULL,
            state=InstanceState.RUNNING,
            backend=backend,
            frontend=RoleStatus(role=Role.FRONTEND, applicable=True),
            launcher_owned=True,
        ),
        "record": LauncherRecord(
            name=name,
            group=name,
            kind=InstanceKind.FULL,
            hub_url="http://localhost:8093",
            env_file=str(env_file),
            backend=ProcRef(pid=pid, port=port),
        ),
        "launcher": {"name": name},
        "env": {
            "FLOW_INSTANCE": name,
            "LOCAL_SERVER_PORT": str(port),
            "VITE_API_URL": f"http://localhost:{port}",
            "FLOWPAD_HUB_URL": "http://localhost:8093",
        },
        "seen_flow_home": None,
        "expected_flow_home": str(expected_flow_home),
    }

    def _resolve(_name):
        state["seen_flow_home"] = os.environ.get("FLOW_HOME")
        return state["status"]

    monkeypatch.setattr(manager, "resolve", _resolve)
    monkeypatch.setattr(registry, "read", lambda _name: state["record"])
    monkeypatch.setattr(atomic, "read_json", lambda _path: state["launcher"])
    monkeypatch.setattr(env, "read_env_file", lambda _name: state["env"])
    monkeypatch.setattr(paths, "launcher_path", lambda _name: tmp_path / "launcher.json")
    monkeypatch.setattr(paths, "env_file", lambda _name: env_file)
    monkeypatch.setenv("FLOWPAD_E2E_INSTANCE", name)
    monkeypatch.delenv("FLOW_HOME", raising=False)
    monkeypatch.setenv("FLOWPAD_PRE_SANDBOX_HOME", str(expected_flow_home.parent))
    return state


def test_resolver_accepts_only_the_agreed_live_launcher_target(resolver_state, resolve_live_e2e_instance):
    live = resolve_live_e2e_instance("FLOWPAD_E2E_INSTANCE")

    assert live == LiveE2EInstance(
        name="qacycle-6",
        backend_port=6106,
        backend_pid=41006,
        hub_url="http://localhost:8093",
    )
    assert resolver_state["seen_flow_home"] == resolver_state["expected_flow_home"]
    with pytest.raises(FrozenInstanceError):
        live.name = "other"  # type: ignore[misc]


@pytest.mark.parametrize(
    ("case", "message"),
    [
        ("missing-launcher", "not launcher-owned"),
        ("self-managed", "not launcher-owned"),
        ("dead", "not live, owned, and listening"),
        ("recycled-pid", "not live, owned, and listening"),
        ("not-listening", "not live, owned, and listening"),
        ("wrong-port", "name/PID/port disagrees"),
        ("wrong-name", "name/PID/port disagrees"),
        ("wrong-env", "generated env disagrees"),
        ("wrong-worktree", "not from this checkout"),
        ("mismatched-hub", "disagree on the Hub"),
    ],
)
def test_resolver_rejects_unsafe_or_disagreeing_targets(case, message, resolver_state, resolve_live_e2e_instance):
    if case == "missing-launcher":
        resolver_state["record"] = None
    elif case == "self-managed":
        resolver_state["status"] = replace(resolver_state["status"], launcher_owned=False)
    elif case == "dead":
        resolver_state["status"] = replace(
            resolver_state["status"],
            backend=replace(resolver_state["status"].backend, alive=False),
        )
    elif case == "recycled-pid":
        resolver_state["status"] = replace(
            resolver_state["status"],
            backend=replace(resolver_state["status"].backend, owned=False),
        )
    elif case == "not-listening":
        resolver_state["status"] = replace(
            resolver_state["status"],
            backend=replace(resolver_state["status"].backend, listening=False),
        )
    elif case == "wrong-port":
        resolver_state["record"] = replace(resolver_state["record"], backend=ProcRef(pid=41006, port=6107))
    elif case == "wrong-name":
        resolver_state["launcher"] = {"name": "someone-else"}
    elif case == "wrong-env":
        resolver_state["env"] = {
            **resolver_state["env"],
            "FLOW_INSTANCE": "someone-else",
        }
    elif case == "wrong-worktree":
        resolver_state["record"] = replace(resolver_state["record"], env_file="/another/checkout/.env.qacycle-6.local")
    else:
        resolver_state["env"] = {
            **resolver_state["env"],
            "FLOWPAD_HUB_URL": "http://localhost:8094",
        }

    with pytest.raises(pytest.fail.Exception, match=message):
        resolve_live_e2e_instance("FLOWPAD_E2E_INSTANCE")


def test_resolver_skips_actionably_without_an_explicit_selector(monkeypatch, resolve_live_e2e_instance):
    monkeypatch.delenv("FLOWPAD_E2E_INSTANCE", raising=False)

    with pytest.raises(pytest.skip.Exception, match="FLOWPAD_E2E_INSTANCE is not set"):
        resolve_live_e2e_instance("FLOWPAD_E2E_INSTANCE")


def test_reconnect_pair_rejects_the_same_instance_twice():
    instance = LiveE2EInstance(
        name="qacycle-6",
        backend_port=6106,
        backend_pid=41006,
        hub_url="http://localhost:8093",
    )

    with pytest.raises(pytest.fail.Exception, match="must be distinct"):
        _local_hub_for_pair(instance, instance)
