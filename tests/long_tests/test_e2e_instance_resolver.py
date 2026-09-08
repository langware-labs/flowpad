"""Narrow contract tests for the long-suite live-instance resolver."""

import os
from contextlib import closing
from dataclasses import FrozenInstanceError, replace
from pathlib import Path
from types import SimpleNamespace

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
from tests.long_tests import conftest as long_conftest
from tests.long_tests.conftest import LiveE2EInstance
from tests.long_tests.test_ws_reconnect_message_catchup import _local_hub_for_pair


@pytest.fixture()
def resolver_state(monkeypatch, tmp_path):
    from flow_sdk.instances import atomic, env, manager, paths, registry

    name = "qacycle-6"
    port = 6106
    pid = 41006
    expected_flow_home = (tmp_path / "real-home" / ".flow").resolve()
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
        flow_home=resolver_state["expected_flow_home"],
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


def test_reconnect_pair_rejects_the_same_instance_twice(tmp_path):
    instance = LiveE2EInstance(
        name="qacycle-6",
        backend_port=6106,
        backend_pid=41006,
        hub_url="http://localhost:8093",
        flow_home=str(tmp_path / "flow-home"),
    )

    with pytest.raises(pytest.fail.Exception, match="must be distinct"):
        _local_hub_for_pair(instance, instance)


@pytest.fixture()
def cli_home_paths(monkeypatch, tmp_path):
    sandbox_home = tmp_path / "sandbox-home"
    cli_home = tmp_path / "real-home"
    monkeypatch.setattr(long_conftest, "_SANDBOX_HOME", str(sandbox_home))
    monkeypatch.setattr(long_conftest, "_SANDBOX_USERPROFILE", str(sandbox_home))
    monkeypatch.setattr(long_conftest, "_REAL_HOME", str(cli_home))
    monkeypatch.setenv("HOME", str(sandbox_home))
    monkeypatch.setenv("USERPROFILE", str(sandbox_home))
    return sandbox_home, cli_home


@pytest.mark.parametrize("original_flow_home", [None, "", "explicit"])
def test_cli_home_swap_preserves_flowpad_root_and_restores_env(
    original_flow_home, cli_home_paths, monkeypatch, tmp_path
):
    from flow_sdk.instance_settings import get_instance_settings

    sandbox_home, cli_home = cli_home_paths
    if original_flow_home == "explicit":
        original_flow_home = str(tmp_path / "explicit-flow-home")
    if original_flow_home is None:
        monkeypatch.delenv("FLOW_HOME", raising=False)
    else:
        monkeypatch.setenv("FLOW_HOME", original_flow_home)
    request = SimpleNamespace(path=Path("test_context_process.py"))

    with closing(long_conftest._real_home_for_cli_subprocess_tests.__wrapped__(request)) as swap:
        injected = next(swap)
        expected_root = Path(original_flow_home) if original_flow_home else sandbox_home / ".flow"
        assert injected == (None if original_flow_home else str(expected_root))
        assert Path.home() == cli_home
        assert os.environ["USERPROFILE"] == str(cli_home)
        settings = get_instance_settings()
        assert settings.flow_home == expected_root
        assert settings.sodot_path.is_relative_to(expected_root)

    assert os.environ.get("FLOW_HOME") == original_flow_home
    assert Path.home() == sandbox_home
    assert os.environ["USERPROFILE"] == str(sandbox_home)


@pytest.mark.parametrize("explicit_override", [None, "absolute", "relative"])
def test_live_resolver_distinguishes_cli_fallback_from_explicit_root(
    explicit_override, resolver_state, cli_home_paths, monkeypatch, tmp_path
):
    from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli_worker import ClaudeCLIWorker
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import AgenticContext
    from flow_sdk.instance_settings import get_instance_settings

    sandbox_home, _ = cli_home_paths
    request = SimpleNamespace(path=Path("test_context_process.py"))
    with closing(long_conftest._real_home_for_cli_subprocess_tests.__wrapped__(request)) as swap:
        injected = next(swap)
        resolver = long_conftest.resolve_live_e2e_instance.__wrapped__(injected)
        with monkeypatch.context() as selected_env:
            expected_root = resolver_state["expected_flow_home"]
            if explicit_override:
                expected_root = str((tmp_path / "selected-flow-home").resolve())
                caller_root = os.path.relpath(expected_root) if explicit_override == "relative" else expected_root
                selected_env.setenv("FLOW_HOME", caller_root)
            parent_root = os.environ["FLOW_HOME"]

            live = resolver("FLOWPAD_E2E_INSTANCE")
            assert live.flow_home == expected_root
            assert resolver_state["seen_flow_home"] == expected_root
            assert os.environ["FLOW_HOME"] == parent_root

            selected_env.setenv("FLOW_INSTANCE", live.name)
            worker_cwd = tmp_path / "worker-cwd"
            worker_env = ClaudeCLIWorker.build_env(
                AgenticContext(workdir=str(worker_cwd), env_vars={"FLOW_HOME": live.flow_home})
            )
            assert worker_env["FLOW_INSTANCE"] == live.name
            assert worker_env["FLOW_HOME"] == expected_root
            assert Path(worker_env["FLOW_HOME"]).is_absolute()
            assert (worker_cwd / worker_env["FLOW_HOME"]).resolve() == Path(expected_root)
            assert os.environ["FLOW_HOME"] == parent_root
            assert get_instance_settings().flow_home == Path(parent_root)
            if not explicit_override:
                assert Path(parent_root) == sandbox_home / ".flow"

    assert "FLOW_HOME" not in os.environ
    assert Path.home() == sandbox_home
