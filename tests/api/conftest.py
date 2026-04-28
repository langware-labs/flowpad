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
        from flow_sdk.server.routes.bootstrap import invalidate_bootstrap_cache
        invalidate_bootstrap_cache()
    except Exception:
        pass


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
            for pty_key, pty_info in list(provider._pty_sessions.items()):
                try:
                    process = pty_info.get("process")
                    if process and hasattr(process, "terminate"):
                        process.terminate()
                except Exception:
                    pass
            provider._pty_sessions.clear()
    except Exception:
        pass
    try:
        from flow_sdk.compute.providers.desktop.pty_session_manager import session_manager
        session_manager.sessions.clear()
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
async def bootstrapped_client(client):
    """Client with bootstrap called -- DB initialized, local entities created."""
    response = await client.get("/api/v1/graph/bootstrap")
    assert response.status_code == 200, f"Bootstrap failed: {response.text}"
    yield client


@pytest_asyncio.fixture
async def user(bootstrapped_client):
    """The @local user entity, fetched via the graph API after bootstrap."""
    response = await bootstrapped_client.get("/api/v1/graph/user")
    assert response.status_code == 200, response.text
    res = ApiResponse(**response.json())
    users = res.data
    assert users and len(users) >= 1, "No users found after bootstrap"
    local_user = users[0]
    return User(**local_user)
