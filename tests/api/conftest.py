"""Shared fixtures for minihub API tests.

Provides an in-process HTTPX AsyncClient that calls the FastAPI app
directly via ASGITransport — no server process or port needed.

Test-isolation model
--------------------
The session-scoped `initialize_test_db` fixture in `tests/conftest.py`
creates ONE SQLiteDBDriver bound to the pytest-asyncio session loop and
registers it in `_driver_instances`. We keep that driver alive for the
whole session.

Between tests we DO NOT close the driver. Closing on a fresh
`asyncio.new_event_loop()` orphans aiosqlite worker threads that were
created on the session loop — those zombies hold the SQLite writer lock
and the next test's `BEGIN IMMEDIATE` blocks. Instead, between tests we
just invalidate process-level caches (bootstrap cache, lazy descriptor)
so the next request re-runs bootstrap; entities accumulate harmlessly
(bootstrap is idempotent on existing rows).
"""

import os

import pytest
import pytest_asyncio

from httpx import ASGITransport, AsyncClient
from flow_sdk.server.app import app
from flow_sdk.builtin.user import User
from flow_sdk.responses.response import ApiResponse


def _invalidate_caches():
    """Cache-only reset between tests.

    Does NOT close the active SQLiteDBDriver — the driver is owned by
    `tests/conftest.py:initialize_test_db` and lives for the whole session.
    Closing here on a fresh event loop leaks aiosqlite worker threads.
    """
    try:
        from flow_sdk.request_context.execution_context import set_execution_context
        set_execution_context(None)
    except Exception:
        pass
    try:
        import flow_sdk.server.middleware.request_transaction_middleware as request_middleware
        request_middleware._LOCAL_USER_CACHE = None
    except Exception:
        pass
    try:
        from flow_sdk.server.routes.bootstrap import invalidate_bootstrap_cache
        invalidate_bootstrap_cache()
    except Exception:
        pass


# Capture the canonical session-start records-root the moment the conftest
# loads — before any test has had a chance to mutate it via
# ``set_default_records_root`` (which writes to ``os.environ['FS_RECORD_PATH']``
# AND rebuilds the InstanceSettings cache). Tests that forget to restore on
# their teardown leak the value, breaking every subsequent test that depends
# on the canonical records dir. The autouse fixture below restores it.
_CANONICAL_FS_RECORD_PATH = os.environ.get("FS_RECORD_PATH")


@pytest_asyncio.fixture(autouse=True)
async def _rebind_session_db_driver():
    """Re-bind the session DB driver before every test.

    Tests that use starlette ``TestClient`` (sync) trigger the FastAPI
    lifespan, whose shutdown calls ``close_db()`` — which pops the cached
    SQLite driver from ``_driver_instances`` and ALSO disposes its engine
    (engine=None, session_factory=None). The next test then sees a
    split-brain: writes hit a freshly-created driver on disk, but reads via
    ``DBEntity._db`` still go through the OLD (closed) driver instance that
    ``initialize_test_db`` rebound at session start. The symptom is either
    silent (``sync_to_db`` succeeds, ``get_one`` returns ``None``) or loud
    (``'NoneType' object is not callable`` from ``self.session_factory()``).

    Restoring both pointers and re-opening the engine on the current event
    loop before each test keeps every read/write on the single session-owned
    driver.
    """
    import tests.conftest as _root_cf
    driver = getattr(_root_cf, "_test_db_driver", None)
    if driver is not None:
        import flow_sdk.db.drivers.db_driver as _ddm
        _ddm._driver_instances["sqlite"] = driver
        from flow_sdk.db.db_entity import DBEntity
        from flow_sdk.db.db_relationship import DBRelationship
        DBEntity._db = driver
        DBRelationship._db = driver
        if driver.session_factory is None:
            try:
                await driver.open()
            except Exception as e:
                import logging as _logging
                _logging.error(f"_rebind_session_db_driver: driver.open() failed: {e!r}")
    _invalidate_caches()
    yield


@pytest.fixture(autouse=True)
def _restore_records_root():
    """Restore ``FS_RECORD_PATH`` and rebuild ``InstanceSettings`` BEFORE and
    AFTER each test. Catches leaks from tests that mutate
    ``set_default_records_root`` in their setup but fail to restore on
    teardown (or restore to a hardcoded wrong value). Restoring at the start
    is critical — restoring only at end leaves the FIRST test after a leak
    seeing the polluted env."""
    def _reset():
        if _CANONICAL_FS_RECORD_PATH and os.environ.get("FS_RECORD_PATH") != _CANONICAL_FS_RECORD_PATH:
            os.environ["FS_RECORD_PATH"] = _CANONICAL_FS_RECORD_PATH
            try:
                from flow_sdk.instance_settings import reset_instance_settings
                reset_instance_settings()
            except Exception:
                pass

    _reset()
    yield
    _reset()


@pytest.fixture(scope="session", autouse=True)
def clean_db():
    """Delete WAL/SHM files at session start; close driver at session end."""
    db_path = os.environ["SQLITE_DATABASE_PATH"]
    for path in [db_path, db_path + "-wal", db_path + "-shm"]:
        if os.path.exists(path):
            try:
                os.remove(path)
            except OSError:
                pass
    yield
    # Session-end cleanup — close the active driver and clear stale WS connections.
    # The session loop is in the process of teardown but still alive here, so
    # an asyncio.run() with a fresh loop is acceptable: there is nothing on
    # the old loop that needs to outlive this call.
    import asyncio
    import flow_sdk.db.drivers.db_driver as db_driver_mod
    driver = db_driver_mod._driver_instances.get("sqlite")
    if driver is not None:
        try:
            asyncio.run(driver.close())
        except Exception:
            pass
        db_driver_mod._driver_instances.pop("sqlite", None)
    try:
        from flow_sdk.core.network.connections import _registry
        _registry.clear()
    except Exception:
        pass


@pytest.fixture
def reset_db_for_testclient():
    """No-op kept for backward compat with `pytestmark.usefixtures(...)`.

    Driver stays alive across the session; entities accumulate harmlessly
    (bootstrap is idempotent). Bootstrap cache is invalidated by
    drain_background_tasks.
    """
    _invalidate_caches()
    yield
    _invalidate_caches()


@pytest_asyncio.fixture(autouse=True)
async def drain_background_tasks():
    """Drain pending asyncio tasks and kill PTY sessions after each test."""
    yield
    import asyncio
    # Kill all PTY sessions to release DB locks held by background reader threads.
    try:
        from flow_sdk.compute.providers import _providers
        provider = _providers.get("local_machine")
        if provider:
            for pty_key, pty_info in list(provider._pty_processes.items()):
                try:
                    process = pty_info.get("process")
                    if process and hasattr(process, "terminate"):
                        process.terminate()
                except Exception:
                    pass
            provider._pty_processes.clear()
    except Exception:
        pass
    try:
        from flow_sdk.compute.providers.desktop.pty_session_manager import pty_registry
        pty_registry.states.clear()
    except Exception:
        pass
    # Invalidate bootstrap cache so next test gets fresh state.
    _invalidate_caches()
    # Give background tasks a chance to finish naturally.
    await asyncio.sleep(0)
    # Cancel and await any remaining tasks (excluding the current one).
    # Note: middleware wiring is intentionally disabled, so this can't
    # leak DB connections — driver methods all use `async with` session
    # contexts which close cleanly even on cancellation paths.
    current = asyncio.current_task()
    pending = [t for t in asyncio.all_tasks() if t is not current and not t.done()]
    for task in pending:
        task.cancel()
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)


@pytest_asyncio.fixture
async def client():
    """Async HTTP client that calls the minihub FastAPI app in-process."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as c:
        yield c


@pytest_asyncio.fixture
async def bootstrap_payload(client) -> dict:
    """The unwrapped bootstrap payload (``ApiResponse.data``), fetched once.

    Shared by ``bootstrapped_client`` and ``user`` so a single bootstrap GET
    serves both — parse it with ``default_compute_node_id`` etc.
    """
    response = await client.get("/api/v1/graph/bootstrap")
    assert response.status_code == 200, f"Bootstrap failed: {response.text}"
    return ApiResponse(**response.json()).data


@pytest_asyncio.fixture
async def bootstrapped_client(client, bootstrap_payload):
    """Client with bootstrap called -- DB initialized, local entities created."""
    yield client


@pytest_asyncio.fixture
async def user(bootstrap_payload):
    """The @local user entity, from the shared bootstrap payload."""
    assert bootstrap_payload and bootstrap_payload.get("user"), "No user found after bootstrap"
    return User(**bootstrap_payload["user"])


# ---------------------------------------------------------------------------
# Shared HTTP helpers (import from api tests to avoid per-file copies)
# ---------------------------------------------------------------------------


async def create_agentic_process(client, **fields) -> str:
    """POST ``/agentic_process`` (defaulting ``worker_type=claude_code``) and
    return the new process id."""
    body = {"worker_type": "claude_code", **fields}
    resp = await client.post("/api/v1/graph/agentic_process", json=body)
    assert resp.status_code == 200, resp.text
    return ApiResponse(**resp.json()).data["id"]


async def get_agentic_process(client, pid: str) -> dict:
    """GET one ``agentic_process`` row (unwrapped ``ApiResponse.data``)."""
    resp = await client.get(f"/api/v1/graph/agentic_process/{pid}")
    assert resp.status_code == 200, resp.text
    return ApiResponse(**resp.json()).data


def default_compute_node_id(bootstrap_payload: dict) -> str:
    """``default_compute_node.id`` from the unwrapped ``bootstrap_payload``."""
    return bootstrap_payload["default_compute_node"]["id"]
