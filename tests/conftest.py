#!/usr/bin/env python3
"""
Pytest configuration and fixtures for flow-cli tests.

Merged from:
- flow-sdk/python/tests/conftest.py (SDK path setup)
- tests/conftest.py (session fixtures: DB init, env, app, async markers)
"""

import asyncio
import atexit
import functools
import logging
import os
import shutil

import pytest

# Set environment variable for testing
os.environ["TESTING"] = "true"


# -----------------------------------------------------------------------------
# CRITICAL: sandbox HOME before any flow_sdk import.
#
# Several flow_sdk modules still hard-code `Path.home() / ".claude"` (e.g.
# transcript_analyzer/resolver.py, fs_records/claude/claude_settings/__init__.py,
# fs_records/claude/claude_debug_log.py, server/routes/bootstrap.py). They
# bypass InstanceSettings.claude_home — the
# contract violation flagged at flow_sdk/core/.../system_profile/utils.py:9.
#
# Overriding HOME redirects every Path.home() call (including those direct
# ones AND the InstanceSettings defaults at base_settings.py:210) into an
# empty sandbox. Without this, the indexer's default_roots() walks the real
# user home: 61 real projects × project_folder_walker_fn recursion =
# 272k folder waypoints, 93s wall — blowing every pytest.mark.timeout(30)
# in test_record_get_id.py / test_index_handler.py / test_scan_handler.py.
#
# Done BEFORE the flow_sdk import below so module-level `Path.home()`
# evaluations (e.g. resolver.py:20's `Final[Path]`) pick up the sandbox.
# -----------------------------------------------------------------------------
import tempfile  # noqa: E402
from pathlib import Path as _Path  # noqa: E402

# Compute the per-process run root with the same stdlib-only rule as
# ``flow_sdk.config.init_temp_dir``. This must happen before importing any
# ``flow_sdk`` module: several modules resolve ``Path.home()`` at import time.
_FLOWPAD_TEMP_DIR_RAW = os.environ.get("FLOWPAD_TEMP_DIR")
_FLOWPAD_TEMP_ROOT = (
    _Path(_FLOWPAD_TEMP_DIR_RAW) if _FLOWPAD_TEMP_DIR_RAW else _Path(tempfile.gettempdir()) / "flowpad_temp"
)
_FLOWPAD_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
_TEST_RUN_ROOT = _Path(tempfile.mkdtemp(prefix="pytest-", dir=_FLOWPAD_TEMP_ROOT))
atexit.register(shutil.rmtree, _TEST_RUN_ROOT, ignore_errors=True)
# Pin every path-bearing override before any ``flow_sdk`` module can snapshot
# pytest-env's legacy shared defaults during import.
os.environ["SQLITE_DATABASE_PATH"] = str(_TEST_RUN_ROOT / "flowpad_test.db")
os.environ["FS_RECORD_PATH"] = str(_TEST_RUN_ROOT / "flowpad_test_records")

_TEST_HOME = _TEST_RUN_ROOT / "home"
for _sub in (".claude", ".codex", ".flow"):
    (_TEST_HOME / _sub).mkdir(parents=True, exist_ok=True)
# Stash the pre-sandbox HOME so child conftests can hand it to subprocess
# environments that need real CLI auth (e.g. tests/long_tests/conftest.py
# restoring HOME for tests that spawn the real Claude/Codex CLI). This is
# the actual home Python resolves on POSIX, macOS, AND Windows. Capture it
# before overriding either variable: POSIX ``Path.home()`` reads HOME, while
# Windows reads USERPROFILE (then HOMEDRIVE/HOMEPATH) and ignores HOME.
os.environ.setdefault("FLOWPAD_PRE_SANDBOX_HOME", str(_Path.home()))
os.environ["HOME"] = str(_TEST_HOME)
os.environ["USERPROFILE"] = str(_TEST_HOME)


# -----------------------------------------------------------------------------
# CRITICAL: force keyring to an in-memory backend BEFORE any flow_sdk import.
#
# pytest sets PYTEST_CURRENT_TEST per-test, which makes flow_sdk's instance
# resolver pick instance_name="test". Any test that reaches enable_secrets()
# or instance.sod without the sod_env fixture would otherwise hit the real
# macOS Keychain with the brand-new "Flowpad.ai.sod_key" service — and if the
# login keychain is in any unusual state, macOS pops a *catastrophic*
# "Keychain Not Found" dialog (which offers "Reset To Defaults" → wipes ALL
# stored passwords). The dialog re-pops per test on Cancel.
#
# This in-memory backend is registered BEFORE any flow_sdk import so the
# real OS keychain is never reachable from the test process. Per-test
# sod_env fixture monkeypatches keyring.get_password/set_password on top of
# this; both layers are belt-and-suspenders.
# -----------------------------------------------------------------------------
import keyring  # noqa: E402
from keyring.backend import KeyringBackend  # noqa: E402
from keyring.errors import PasswordDeleteError  # noqa: E402


class _InMemoryKeyring(KeyringBackend):
    """Process-local in-memory keyring backend.

    Replaces the real OS keyring globally for the test session. Tests that
    need to inspect keyring contents directly can read ``_InMemoryKeyring._store``.
    """

    priority = 1  # type: ignore[assignment]
    _store: dict[tuple[str, str], str] = {}

    def get_password(self, service, username):
        return self._store.get((service, username))

    def set_password(self, service, username, password):
        self._store[(service, username)] = password

    def delete_password(self, service, username):
        if (service, username) not in self._store:
            raise PasswordDeleteError(f"no entry for {service}/{username}")
        del self._store[(service, username)]


keyring.set_keyring(_InMemoryKeyring())

# Force the SOD-key path to use the (in-memory) keyring above rather than
# shelling out to the vendored, signed flow-rs binary — which, once committed,
# IS present in the source tree and would otherwise reach the REAL OS keychain
# (defeating the in-memory backend and risking the catastrophic dialog above).
# See flow_sdk/flow_rs_binary.py::vendored_flow_rs_enabled.
os.environ["FLOWPAD_DISABLE_VENDORED_FLOW_RS"] = "1"

# Neutralize inherited Electron-desktop env for the test session. When the suite
# is launched from inside the Flowpad desktop app's PTY (an agentic-process
# worker), the desktop exports these vars and they leak into the tests:
#   FLOWPAD_DESKTOP   flips the consent gate into its desktop-only branch
#                     (is_secrets_enabled marker-only => False)
#   SOD_ENC_KEY       makes sod_key resolve to a fixed env key that bypasses the
#                     keychain entirely (breaks keychain-loss/recovery tests)
#   DEPLOY_ENV        leaks "desktop" — an invalid value for tooling that parses it
# Default the session to a clean non-desktop env; tests that exercise these paths
# set the vars themselves via monkeypatch. Listed explicitly so the next leak is a
# one-line addition here rather than another scattered special case.
for _inherited in ("FLOWPAD_DESKTOP", "SOD_ENC_KEY", "DEPLOY_ENV"):
    os.environ.pop(_inherited, None)

from flow_sdk.config import FLOWPAD_TEMP_DIR

# Keep the pre-import bootstrap rule in lockstep with ``flow_sdk.config``.
assert _Path(FLOWPAD_TEMP_DIR) == _FLOWPAD_TEMP_ROOT


def pytest_configure(config):
    """Root every pytest-owned writable path under this process's run root."""
    # pytest-env applies the legacy shared DB value from pytest.ini during
    # startup. Reassert the per-process paths during root configuration so
    # API cleanup and any pre-fixture settings lookup cannot touch another run.
    os.environ["SQLITE_DATABASE_PATH"] = str(_TEST_RUN_ROOT / "flowpad_test.db")
    os.environ["FS_RECORD_PATH"] = str(_TEST_RUN_ROOT / "flowpad_test_records")
    if not getattr(config.option, "basetemp", None):
        config.option.basetemp = str(_TEST_RUN_ROOT / "tmp")


from pytest_asyncio import is_async_test


def pytest_collection_modifyitems(items):
    pytest_asyncio_tests = (item for item in items if is_async_test(item))
    session_scope_marker = pytest.mark.asyncio(loop_scope="session")
    for async_test in pytest_asyncio_tests:
        async_test.add_marker(session_scope_marker, append=False)


@pytest.fixture(autouse=True)
def _restore_main_thread_event_loop():
    """Keep the main thread's event-loop slot usable across the whole run.

    A sync test that calls ``asyncio.run(...)`` leaves the thread with NO
    current loop (``asyncio.run`` closes its loop and unsets it on exit), so —
    under pytest-randomly's shuffled order — any later session-loop async test
    dies with "There is no current event loop in thread 'MainThread'". Restore
    a fresh loop whenever a test leaves the slot empty or closed.
    """
    yield
    import asyncio as _asyncio

    try:
        loop = _asyncio.get_event_loop_policy().get_event_loop()
        closed = loop.is_closed()
    except RuntimeError:
        closed = True
    if closed:
        _asyncio.set_event_loop(_asyncio.new_event_loop())


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

    from flow_sdk.fs_store.operations.claude_project import clean_temp_projects

    asyncio.get_event_loop().run_until_complete(clean_temp_projects())
    yield
    asyncio.get_event_loop().run_until_complete(clean_temp_projects())


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

    from flow_sdk.db.drivers.db_driver import DBConfig, _driver_instances
    from flow_sdk.db.drivers.sqlite import SQLiteDBDriver

    # Use a temp file instead of :memory:
    tmp_dir = tmp_path_factory.mktemp("db")
    db_path = str(tmp_dir / "test.db")

    config = DBConfig(database=db_path)
    driver = SQLiteDBDriver(config)
    _driver_instances["sqlite"] = driver
    _test_db_driver = driver
    _test_db_initialized = True

    await driver.open()

    # Force-rebind the LazyDBDriver caches on DBEntity / DBRelationship to this
    # test driver. Order-of-fixture hazard: an earlier session-autouse fixture
    # (e.g. clean_claude_temp_projects) can hit `cls._db` before this fixture
    # runs, which freezes the descriptor onto whichever driver was in
    # `_driver_instances` at that time. Overwriting `_driver_instances` here
    # is not enough — once LazyDBDriver has set the attribute on the owning
    # class, subsequent accesses bypass the registry. Re-assigning here keeps
    # entity queries pointed at the schema this fixture just created.
    from flow_sdk.db.db_entity import DBEntity
    from flow_sdk.db.db_relationship import DBRelationship

    DBEntity._db = driver
    DBRelationship._db = driver

    yield driver

    # Cleanup: close the driver to stop aiosqlite worker threads
    await driver.close()


@pytest.fixture(scope="session")
def app():
    """Get the FastAPI app instance."""
    from flow_sdk.server.app import app as minihub_app

    return minihub_app


@pytest.fixture(autouse=True)
def isolated_records_root(tmp_path, monkeypatch):
    """Redirect the default records root to a temp dir for every test.

    Sets FS_RECORD_PATH env var (which BaseInstanceSettings.from_env reads)
    and resets the cached singleton so the next get_instance_settings()
    rebuilds with the new path. Mirrors the per-instance contract — no
    module-level mutation, the InstanceSettings singleton is the single
    source of truth.
    """
    from flow_sdk.instance_settings import reset_instance_settings  # noqa: PLC0415

    monkeypatch.setenv("FS_RECORD_PATH", str(tmp_path / "records"))
    reset_instance_settings()
    yield tmp_path / "records"
    reset_instance_settings()


# ----------------------------------------------------------------------
# Phase C: per-instance sod sandbox — usable from every test directory.
#
# Sets up FLOW_HOME=<tmp_path>, FLOW_INSTANCE=test-<uuid>, in-memory keyring
# for the per-instance Fernet key, and calls enable_secrets() so the consent
# gate is open. Yields the active InstanceSettings.
#
# Replaces the per-file ``memory_keyring`` fixtures that patched
# ``credentials_mod.keyring`` — that import is gone in Phase C.
# ----------------------------------------------------------------------


@pytest.fixture
def sod_env(monkeypatch, tmp_path):
    import uuid as _uuid
    from pathlib import Path

    instance_name = f"test-{_uuid.uuid4().hex[:8]}"
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", instance_name)
    monkeypatch.delenv("FLOWPAD_DEV", raising=False)
    monkeypatch.delenv("FLOWPAD_TEST", raising=False)

    from flow_sdk.instance_settings import (
        get_instance_settings,
        reset_instance_settings,
    )

    reset_instance_settings()

    store: dict[tuple[str, str], str] = {}
    import keyring as _keyring
    import keyring.errors as _keyring_errors

    def _get(service, account):
        return store.get((service, account))

    def _set(service, account, value):
        store[(service, account)] = value

    def _del(service, account):
        if (service, account) not in store:
            raise _keyring_errors.PasswordDeleteError("not in fake")
        del store[(service, account)]

    monkeypatch.setattr(_keyring, "get_password", _get)
    monkeypatch.setattr(_keyring, "set_password", _set)
    monkeypatch.setattr(_keyring, "delete_password", _del)

    from flow_sdk.fs_store import set_default_records_root

    set_default_records_root(Path(tmp_path) / "records")

    from flow_sdk.cli.auth.secrets import enable_secrets

    assert enable_secrets() is True

    yield get_instance_settings()
    reset_instance_settings()
