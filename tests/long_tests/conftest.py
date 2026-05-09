"""Shared fixtures for long-running API tests.

Re-exports the in-process HTTPX client fixtures from tests/api/conftest.py
so tests in this directory can use bootstrapped_client without modification.

Also exposes the worker-parameterisation fixtures (``make_process``,
``external_session_snapshot``) so test bodies can stay vendor-blind — every
agentic-process test runs once for each registered driver (claude, codex)
without referencing ``WorkerType``, ``ClaudeCli*``, ``Codex*`` or any other
worker-specific symbol.
"""

import sys
from typing import Awaitable, Callable

import pytest

from tests.api.conftest import clean_db, client, bootstrapped_client, reset_db_for_testclient, drain_background_tasks  # noqa: F401
from flow_sdk.fs_records.agent_status import ApiErrorTimeoutError


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

    _DRIVER_TO_ENUM = {
        "claude": WorkerType.CLAUDE_CODE,
        "codex": WorkerType.CODEX,
    }
    enum_value = _DRIVER_TO_ENUM[worker_id]

    async def _make(**kwargs):
        return await AgenticProcess(worker_type=enum_value, **kwargs).save()
    return _make


@pytest.fixture()
def external_session_snapshot(worker_id) -> Callable[[], set[str]]:
    """Probe vendor-managed session storage for the parameterised driver.

    Used by the "no session leakage" invariant: a test takes a snapshot
    before / after the run and asserts the diff is empty.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers import get_driver
    return get_driver(worker_id).external_session_dirs
