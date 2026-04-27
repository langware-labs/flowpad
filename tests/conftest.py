#!/usr/bin/env python3
"""
Pytest configuration and fixtures for flow-cli tests.

Merged from:
- flow-sdk/python/tests/conftest.py (SDK path setup)
- tests/conftest.py (session fixtures: DB init, env, app, async markers)
"""

import os
import asyncio
import functools
import logging

import pytest

# Set environment variable for testing
os.environ["TESTING"] = "true"

from flow_sdk.config import FLOWPAD_TEMP_DIR

# Ensure tests use a separate DB path (prevents conflicts with a running dev server)
if not os.environ.get("SQLITE_DATABASE_PATH"):
    os.environ["SQLITE_DATABASE_PATH"] = str(os.path.join(FLOWPAD_TEMP_DIR, "flowpad_test.db"))
# Isolate filesystem records from dev/prod data
if not os.environ.get("FS_RECORD_PATH"):
    os.environ["FS_RECORD_PATH"] = str(os.path.join(FLOWPAD_TEMP_DIR, "flowpad_test_records"))


def pytest_configure(config):
    """Root all tmp_path fixtures under FLOWPAD_TEMP_DIR."""
    if not getattr(config.option, "basetemp", None):
        config.option.basetemp = FLOWPAD_TEMP_DIR

from pytest_asyncio import is_async_test


def pytest_collection_modifyitems(items):
    pytest_asyncio_tests = (item for item in items if is_async_test(item))
    session_scope_marker = pytest.mark.asyncio(loop_scope="session")
    for async_test in pytest_asyncio_tests:
        async_test.add_marker(session_scope_marker, append=False)


def async_context(func):
    """Decorator to run async tests with proper async event loop."""
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        try:
            loop = asyncio.get_event_loop()
            if loop.is_closed():
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
        except RuntimeError:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
        return loop.run_until_complete(func(*args, **kwargs))
    return wrapper


# ==================== Session-scoped fixtures ====================

@pytest.fixture(scope="session", autouse=True)
def clean_claude_temp_projects():
    """Remove temp-path Claude projects before and after the test session."""
    import asyncio
    from flow_sdk.fs_records.claude.claude_project import ClaudeProjectFsRecord
    asyncio.get_event_loop().run_until_complete(ClaudeProjectFsRecord.clean_temp_projects())
    yield
    asyncio.get_event_loop().run_until_complete(ClaudeProjectFsRecord.clean_temp_projects())


@pytest.fixture(scope="session", autouse=True)
def load_env():
    """Load environment variables before any tests run."""
    from flow_sdk.cli.env_loader import cli_init
    cli_init()


_test_db_driver = None
_test_db_initialized = False


@pytest.fixture(scope="session", autouse=True)
async def initialize_test_db(tmp_path_factory):
    """Initialize test database once per session."""
    global _test_db_driver, _test_db_initialized

    logging.basicConfig(level=logging.WARNING)

    from flow_sdk.db.drivers.sqlite import SQLiteDBDriver
    from flow_sdk.db.drivers.db_driver import DBConfig, _driver_instances

    # Use a temp file instead of :memory:
    tmp_dir = tmp_path_factory.mktemp("db")
    db_path = str(tmp_dir / "test.db")

    config = DBConfig(database=db_path)
    driver = SQLiteDBDriver(config)
    _driver_instances['sqlite'] = driver
    _test_db_driver = driver
    _test_db_initialized = True

    await driver.open()
    yield driver

    # Cleanup: close the driver to stop aiosqlite worker threads
    await driver.close()


@pytest.fixture(scope="session")
def app():
    """Get the FastAPI app instance."""
    from flow_sdk.server.app import app as minihub_app
    return minihub_app


@pytest.fixture(autouse=True)
def isolated_records_root(tmp_path):
    """Redirect the default records root to a temp dir for every test."""
    from flow_sdk.fs_store.record import (
        get_default_records_root,
        set_default_records_root,
    )

    original = get_default_records_root()
    set_default_records_root(tmp_path / "records")
    yield tmp_path / "records"
    set_default_records_root(original)
