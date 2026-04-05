"""
Shared fixtures for minihub API tests.

Provides an in-process HTTPX AsyncClient that calls the FastAPI app
directly via ASGITransport -- no server process or port needed.
"""

import os

import pytest
import pytest_asyncio

from httpx import ASGITransport, AsyncClient
from flow_sdk.server.app import app
from flow_sdk.builtin.user import User
from flow_sdk.responses.response import ApiResponse


def _reset_db_state():
    """Clear all cached DB state so the next access creates a fresh event-loop-bound session."""
    import asyncio

    import flow_sdk.db.database as db_mod
    import flow_sdk.db.drivers.db_driver as db_driver_mod
    from flow_sdk.db.db_entity import DBEntity
    from flow_sdk.db.drivers.db_driver import LazyDBDriver

    # Close the SQLite driver's own engine before dropping the reference.
    # Without this, the orphaned engine holds the DB file open, causing
    # "disk I/O error" when the next test opens a new connection to the same file.
    driver = db_driver_mod._driver_instances.get("sqlite")
    if driver is not None:
        try:
            loop = asyncio.new_event_loop()
            loop.run_until_complete(driver.close())
            loop.close()
        except Exception:
            pass

    db_mod._session_factory = None
    db_mod._engine = None
    db_driver_mod._driver_instances.clear()
    # LazyDBDriver caches the resolved driver on DBEntity (not Entity).
    # Reset it back to a fresh descriptor so the next access calls get_db_driver().
    # __set_name__ is only auto-called in class bodies, so set _name/_owner manually.
    lazy = LazyDBDriver()
    lazy._name = "_db"
    lazy._owner = DBEntity
    DBEntity._db = lazy


@pytest.fixture(scope="session", autouse=True)
def clean_db():
    """Delete the test SQLite DB file (and WAL/SHM files) before the session to prevent state leaking between runs."""
    # Reset the DB singleton FIRST — if the production server's modules were already
    # imported, the singleton may point to the production DB regardless of the env var.
    _reset_db_state()
    db_path = os.environ["SQLITE_DATABASE_PATH"]
    for path in [db_path, db_path + "-wal", db_path + "-shm"]:
        if os.path.exists(path):
            os.remove(path)
    yield
    # Dispose the DB engine so aiosqlite threads terminate and the process exits cleanly.
    import asyncio
    import flow_sdk.db.database as db_mod
    if db_mod._engine is not None:
        try:
            loop = asyncio.new_event_loop()
            loop.run_until_complete(db_mod._engine.dispose())
            loop.close()
        except Exception:
            pass
        db_mod._engine = None
        db_mod._session_factory = None
    # Clear stale WS connections.
    from flow_sdk.core.network.connections import _registry
    _registry.clear()


@pytest.fixture
def reset_db_for_testclient():
    """Reset DB state so starlette TestClient gets a fresh event-loop-bound session.

    Use as autouse=True in test modules that create TestClient inside tests.
    Prevents cross-event-loop aiosqlite errors when async fixtures (bootstrapped_client)
    have already initialized _session_factory in the pytest async event loop.
    """
    _reset_db_state()
    yield
    # TestClient.close() calls close_db() via ASGI lifespan; clear any remnants.
    _reset_db_state()


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
