"""Shared fixtures for long-running API tests.

Re-exports the in-process HTTPX client fixtures from tests/api/conftest.py
so tests in this directory can use bootstrapped_client without modification.

Also exposes the worker-parameterisation fixtures (``make_process``,
``external_session_snapshot``) so test bodies can stay vendor-blind — every
agentic-process test runs once for each registered driver (claude, codex)
without referencing ``WorkerType``, ``ClaudeCli*``, ``Codex*`` or any other
worker-specific symbol.
"""

import os
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable
from unittest.mock import patch

import pytest

# tests/conftest.py overrides HOME to a sandbox tempdir to keep the indexer
# from walking the user's real home. Long tests that spawn real Claude/Codex
# CLIs need real HOME for auth (``$HOME/.claude/.credentials.json``); the
# sandbox HOME makes every CLI subprocess hit ``Not logged in``. Indexer-driven
# long tests still need sandbox HOME so the file walker doesn't recurse the
# user's real projects tree.
#
# We read the pre-sandbox HOME from ``FLOWPAD_PRE_SANDBOX_HOME``, which the
# parent ``tests/conftest.py`` stashes BEFORE its own ``HOME`` override. That
# is the only reliable source: ``pwd.getpwuid(os.getuid()).pw_dir`` returns
# the passwd-entry home (wrong under ``sudo -u`` / CI service accounts) and
# ``pwd`` doesn't exist on Windows at all. The env-var handshake works on
# every platform CLAUDE.md says we support.
_REAL_HOME = os.environ.get("FLOWPAD_PRE_SANDBOX_HOME") or os.path.expanduser("~")
_SANDBOX_HOME = os.environ["HOME"]
_SANDBOX_USERPROFILE = os.environ["USERPROFILE"]


@dataclass(frozen=True)
class LiveE2EInstance:
    """A launcher-owned backend that is safe for a long test to target."""

    name: str
    backend_port: int
    backend_pid: int
    hub_url: str


def _normalized_url(value: str) -> str:
    return value.rstrip("/")


@pytest.fixture()
def resolve_live_e2e_instance() -> Callable[[str], LiveE2EInstance]:
    """Resolve an explicitly selected, live launcher-owned E2E instance.

    Pytest sandboxes HOME before importing Flowpad, while these tests target
    instances launched under the caller's real flow root. The resolver uses an
    explicit FLOW_HOME when supplied and otherwise derives that real root from
    FLOWPAD_PRE_SANDBOX_HOME. Every selected target fails closed unless the
    manager, launcher registry, and generated env file agree.
    """

    def _resolve(env_key: str) -> LiveE2EInstance:
        from flow_sdk.instances import env, manager, paths, registry
        from flow_sdk.instances.atomic import read_json
        from flow_sdk.instances.errors import NameInvalid
        from flow_sdk.instances.model import Role

        name = os.environ.get(env_key, "").strip()
        if not name:
            pytest.skip(f"{env_key} is not set; select a launcher-owned cycle instance with {env_key}=<name>")
        try:
            paths.validate_name(name)
        except NameInvalid as exc:
            pytest.fail(f"unsafe {env_key}={name!r}: {exc}", pytrace=False)

        real_home = os.environ.get("FLOWPAD_PRE_SANDBOX_HOME") or _REAL_HOME
        flow_home = os.environ.get("FLOW_HOME") or str(Path(real_home) / ".flow")
        with patch.dict(os.environ, {"FLOW_HOME": flow_home}):
            try:
                status = manager.resolve(name)
                record = registry.read(name)
                launcher = read_json(paths.launcher_path(name))
                instance_env = env.read_env_file(name)
                expected_env_file = paths.env_file(name).resolve()
            except Exception as exc:
                pytest.fail(
                    f"could not validate {env_key}={name!r} from launcher records: {exc}",
                    pytrace=False,
                )

        backend = status.role(Role.BACKEND)
        if record is None or not status.launcher_owned:
            pytest.fail(
                f"unsafe {env_key}={name!r}: instance is not launcher-owned",
                pytrace=False,
            )
        if not (backend.applicable and backend.alive and backend.owned and backend.listening):
            pytest.fail(
                f"unsafe {env_key}={name!r}: backend is not live, owned, and listening",
                pytrace=False,
            )
        if (
            status.name != name
            or type(backend.port) is not int
            or not 0 < backend.port <= 65535
            or type(backend.pid) is not int
            or backend.pid <= 0
        ):
            pytest.fail(
                f"unsafe {env_key}={name!r}: manager returned an invalid backend identity",
                pytrace=False,
            )

        recorded_backend = record.ref(Role.BACKEND)
        if (
            launcher.get("name") != name
            or record.name != name
            or recorded_backend is None
            or recorded_backend.port != backend.port
            or recorded_backend.pid != backend.pid
        ):
            pytest.fail(
                f"unsafe {env_key}={name!r}: launcher name/PID/port disagrees with the live backend",
                pytrace=False,
            )
        try:
            recorded_env_file = Path(record.env_file).resolve()
        except (OSError, TypeError):
            recorded_env_file = None
        if recorded_env_file != expected_env_file:
            pytest.fail(
                f"unsafe {env_key}={name!r}: launcher env file is not from this checkout",
                pytrace=False,
            )

        api_url = f"http://localhost:{backend.port}"
        if (
            instance_env.get("FLOW_INSTANCE") != name
            or instance_env.get("LOCAL_SERVER_PORT") != str(backend.port)
            or _normalized_url(instance_env.get("VITE_API_URL", "")) != api_url
        ):
            pytest.fail(
                f"unsafe {env_key}={name!r}: generated env disagrees with the live backend",
                pytrace=False,
            )
        if _normalized_url(instance_env.get("FLOWPAD_HUB_URL", "")) != _normalized_url(record.hub_url):
            pytest.fail(
                f"unsafe {env_key}={name!r}: generated env and launcher disagree on the Hub",
                pytrace=False,
            )

        return LiveE2EInstance(
            name=name,
            backend_port=backend.port,
            backend_pid=backend.pid,
            hub_url=_normalized_url(record.hub_url),
        )

    return _resolve


# Test modules whose tests spawn real Claude/Codex/Copilot CLI subprocesses and need
# real ``$HOME`` for credentials. Anything not in this set keeps the parent
# conftest's sandbox HOME.
_REAL_HOME_TEST_MODULES = frozenset(
    {
        "test_agentic_process",
        "test_gmail_agent_source",
        "test_slack_agent_source",
        "test_blocks_email_workflow",
        "test_agentic_process_prompt_streaming",
        "test_agentic_cli_shell_mix",
        "test_claude_cli",
        "test_clean_claude_pty",
        "test_clean_claude_pty_stress",
        "test_cli_driver_binary_smoke",
        "test_markdown_index",
        "test_prompt_queue_integration",
        "test_process_status_report_stream",
        "test_process_hooks_multi_vendor",
        "test_relaunch_kills_session_orphan",
        "test_agent",
        "test_debug_log_records",
        "test_skill_chip_live_stream",
        "test_skill_transcript_analysis",
        "test_docs_browse_skill",
        "test_context_process",
        "test_system_prompt",
        "test_settings_instruction",
        "test_asset_cleanup_agent",
        "test_context_folder_worker",
        "test_artifact_real_worker",
        # Not a CLI test: reads the real ``~/.flow/instances/*`` rig (ports,
        # pids) of two running instances, which the sandbox HOME hides.
        "test_ws_reconnect_message_catchup",
    }
)


@pytest.fixture(autouse=True)
def _real_home_for_cli_subprocess_tests(request):
    """Restore real ``$HOME`` for tests that spawn real worker CLI subprocesses.

    Scope of this fixture is **subprocess auth only**: the CLI inherits the
    swapped ``$HOME`` via ``os.environ`` propagation and reads its credentials
    from the user's real ``~/.claude/.credentials.json``. **In-process**
    flow_sdk state stays anchored to the sandbox — ``InstanceSettings`` was
    built under sandbox HOME at flow_sdk import time and its cached
    ``claude_projects_dir`` / ``codex_sessions_dir`` do NOT track this swap.
    Code that calls ``Path.home()`` at request time (e.g. ``resolver.py`` after
    its lazy refactor) DOES see the swap.

    If a test in the allowlist needs to assert on in-process Claude project
    enumeration, expect zero results: the indexer still walks the sandbox.

    Tests in ``_REAL_HOME_TEST_MODULES`` need the user's real ``.claude/`` so
    the CLI subprocess inherits working auth. All other long tests keep the
    sandbox HOME from the parent conftest so the indexer doesn't walk the
    real projects tree.
    """
    module_stem = request.path.stem
    if module_stem in _REAL_HOME_TEST_MODULES:
        os.environ["HOME"] = _REAL_HOME
        os.environ["USERPROFILE"] = _REAL_HOME
        try:
            yield
        finally:
            os.environ["HOME"] = _SANDBOX_HOME
            os.environ["USERPROFILE"] = _SANDBOX_USERPROFILE
    else:
        yield


from flow_sdk.builtin.worker_status import ApiErrorTimeoutError  # noqa: E402
from tests.api.conftest import (  # noqa: F401, E402
    _rebind_session_db_driver,
    bootstrap_payload,
    bootstrapped_client,
    clean_db,
    client,
    drain_background_tasks,
    reset_db_for_testclient,
)


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    """Convert TimeoutError / ApiErrorTimeoutError failures to skips.

    pytest-asyncio 0.24 uses finalizers, so try/yield/except fixtures do not
    catch exceptions from async tests.  This hook intercepts the report after
    the call phase and downgrades the result when the failure is an external
    infrastructure problem (API slow or unreachable), not a logic error.
    """
    outcome = yield
    rep = outcome.get_result()
    if rep.when == "call" and rep.failed and call.excinfo is not None:
        if issubclass(call.excinfo.type, (ApiErrorTimeoutError, TimeoutError)):
            rep.outcome = "skipped"
            rep.longrepr = ("", 0, f"Skipped: Anthropic API issue — {call.excinfo.value}")


@pytest.fixture()
async def local_project(initialize_test_db, tmp_path):
    """Create an @local Project with tmp_path as its workdir, cleaned up after the test."""
    from flow_sdk.builtin.project import Project

    existing = await Project.get_by_uname("local")
    if existing:
        yield existing
        return

    project = Project(
        uname="local",
        name="local",
        fs_storage_mount_path=str(tmp_path),
    )
    await project.save()
    yield project
    await project.delete()


@pytest.fixture()
async def local_compute_node(initialize_test_db):
    """Get or create the @local ComputeNode. Deletes it after the test only if this fixture created it."""
    from flow_sdk.builtin.faas.compute_node import ComputeNode
    from flow_sdk.builtin.user import User
    from flow_sdk.config import ComputeProviderType, StorageProvider
    from flow_sdk.flowpad_types.runtime_environment import RuntimeEnvironment
    from flow_sdk.server.routes.bootstrap import _new_provider_id

    created = False
    node = await ComputeNode.get_by_uname("local")
    if node is None:
        user = await User.get_by_uname("local")
        node = ComputeNode(
            uname="local",
            name="@local",
            runtime=RuntimeEnvironment(name="local_desktop_runtime"),
            node_provider_type=ComputeProviderType.LOCAL_MACHINE,
            fs_storage_provider=StorageProvider.SANDBOX,
            fs_storage_mount_path="/" if sys.platform != "win32" else "C:\\",
            visitor_role="owner",
            node_provider_id=_new_provider_id("name"),
        )
        await node.save(owner=user)
        created = True
    elif not node.node_provider_id:
        node.node_provider_id = _new_provider_id("name")
        await node.save()

    yield node

    if created:
        await node.delete()


@pytest.fixture()
def allocate_ports(unused_tcp_port_factory):
    """Return a callable that allocates N free TCP ports.

    Usage::
        port, = allocate_ports()          # one port
        p1, p2 = allocate_ports(2)        # two ports
    """

    def _allocate(n: int = 1) -> tuple:
        return tuple(unused_tcp_port_factory() for _ in range(n))

    return _allocate


@pytest.fixture()
def live_backend(initialize_test_db, allocate_ports, tmp_path, monkeypatch):
    """A real backend subprocess on THIS pytest session's DB. Yields its port.

    For tests whose subject is CLI-shaped: ``flow record create``, ``flow
    artifact``, a skill's ``source_ctl.py``. Those reach the instance over
    loopback and have no in-process path, so exercising them needs a running
    server — but the test itself can stay HTTP-free, because pointing the
    backend at the session's own SQLite file lets it read back with the entity
    SDK whatever a worker wrote through the route. (WAL plus the driver's
    existing busy_timeout is what makes the two processes safe on one file.)

    ``FLOW_INSTANCE``/``FLOW_HOME`` are pinned for the duration, so every
    subprocess the test spawns — including workers a driver spawns underneath
    it — resolves to this instance and not to the developer's own.

    Booting from an empty ``FLOW_HOME`` is deliberate: the backend seeds system
    projects (Agents, data-source specs) on the way up, which is what lets a
    test start from nothing.

    Function-scoped on purpose. The boot is ~3s, and an instance outliving its
    test would go on polling sources the next one does not expect.
    """
    from flow_sdk.db.drivers.db_driver import _driver_instances

    driver = _driver_instances.get("sqlite")
    assert driver is not None, "the session DB driver is not initialized"

    (port,) = allocate_ports()
    name = f"live-e2e-{uuid.uuid4().hex[:8]}"
    flow_home = tmp_path / "flow-home"

    env = {
        **os.environ,
        "FLOW_INSTANCE": name,
        "FLOW_HOME": str(flow_home),
        "SQLITE_DATABASE_PATH": str(driver.config.database),
        "LOCAL_SERVER_PORT": str(port),
        "MINIHUB_HOST": "127.0.0.1",
        "MINIHUB_RELOAD": "False",
        "FLOWPAD_SKIP_DOTENV": "true",
    }
    log = tmp_path / "backend.log"
    with log.open("wb") as sink:
        proc = subprocess.Popen(
            [sys.executable, "-m", "flow_sdk.server.run"], env=env, stdout=sink, stderr=sink
        )

    monkeypatch.setenv("FLOW_INSTANCE", name)
    monkeypatch.setenv("FLOW_HOME", str(flow_home))

    try:
        _await_backend_health(proc, port, log)
        yield port
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=3)


def _await_backend_health(proc: subprocess.Popen, port: int, log: Path) -> None:
    """Block until the instance answers, and fail with its log if it never does.

    Fixed 60s ceiling: a backend that has not bound a port by then is broken,
    not slow, and the log says why — which is worth more than a longer wait.
    """
    import requests

    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            pytest.fail(f"backend exited {proc.returncode}\n{log.read_text(errors='replace')[-3000:]}")
        try:
            if requests.get(f"http://127.0.0.1:{port}/health/status", timeout=2).status_code == 200:
                return
        except requests.RequestException:
            pass
        time.sleep(0.5)
    pytest.fail(f"backend never became healthy\n{log.read_text(errors='replace')[-3000:]}")


# ─────────────────────────────────────────────────────────────────────────────
# Worker parameterisation
# ─────────────────────────────────────────────────────────────────────────────
# Tests touching AgenticProcess parameterise over every registered driver. Test
# bodies stay vendor-blind: they take ``make_process`` (a factory that builds
# an AgenticProcess wired to the parameterised worker) and
# ``external_session_snapshot`` (a probe that returns the driver's vendor-
# managed session-storage names) instead of mentioning ``WorkerType``,
# ``ClaudeCli*``, or ``Codex*`` directly.
#
# Anything the test body still needs to know about its worker should be
# expressed as another driver method here, not as an ``if worker_id == ...``
# branch in the test.

_WORKER_PARAMS = [
    pytest.param("claude", id="claude"),
    pytest.param("codex", id="codex"),
    pytest.param("copilot", id="copilot"),
]


@pytest.fixture(params=_WORKER_PARAMS)
def worker_id(request) -> str:
    """The driver name for this parameterised run.

    Internal — consumed by ``make_process`` and ``external_session_snapshot``.
    Tests SHOULD NOT import this directly (the rule: no worker references
    in test bodies).
    """
    return request.param


@pytest.fixture()
def make_process(worker_id) -> Callable[..., Awaitable]:
    """Factory that builds an ``AgenticProcess`` wired to the parameterised worker.

    Tests call ``await make_process(**kwargs)`` instead of constructing
    AgenticProcess directly so the worker stays invisible. Any extra
    constructor kwargs the test needs (workdir, additional_dirs, …) are
    passed through unchanged — they're vendor-neutral.

    Maps the driver short-id (``claude`` / ``codex``) to the corresponding
    ``WorkerType`` enum value the entity stores on disk (``claude_code`` /
    ``codex``). The mapping lives in the fixture, not test bodies.
    """
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.flowpad_types.enums import WorkerType
    from tests.long_tests._model_tier import small_model_for

    _DRIVER_TO_ENUM = {
        "claude": WorkerType.CLAUDE_CODE,
        "codex": WorkerType.CODEX,
        "copilot": WorkerType.COPILOT,
    }
    enum_value = _DRIVER_TO_ENUM[worker_id]

    async def _make(**kwargs):
        # Default every agentic-process test to the portable small tier. Native
        # Copilot resolves it to vendor auto and omits --model. Tests that need
        # a specific model still win: their
        # ``cli_config['model']`` is preserved, and only the key is defaulted.
        cli_config = {**(kwargs.pop("cli_config", None) or {})}
        model = small_model_for(enum_value)
        if model:
            cli_config.setdefault("model", model)
        return await AgenticProcess(worker_type=enum_value, cli_config=cli_config, **kwargs).save()

    return _make


@pytest.fixture()
def external_session_snapshot(worker_id) -> Callable[[], set[str]]:
    """Probe vendor-managed session storage for the parameterised driver.

    Used by the "no session leakage" invariant: a test takes a snapshot
    before / after the run and asserts the diff is empty.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers import get_driver

    return get_driver(worker_id).external_session_dirs
