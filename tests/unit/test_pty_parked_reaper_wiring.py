"""Server startup/shutdown wiring of the PtyRegistry parked-id reaper.

The sweep existed for a long time with no caller (``pty_registry._cleanup_task``
was ``None`` on every live instance), so the guard here is the wiring itself:
startup leaves the loop running, in parked-only mode, and shutdown stops it.
Stays narrow — full server boot is out of scope, like test_server_lifecycle.py.
"""

from __future__ import annotations

import inspect

import pytest

from flow_sdk.compute.providers.desktop.pty_session_manager import PtyRegistry

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


@pytest.fixture(autouse=True)
def reset_registry():
    PtyRegistry.reset_instance()
    yield
    PtyRegistry.reset_instance()


async def test_startup_helper_starts_parked_only_loop():
    """_start_pty_parked_reaper leaves a running loop that never arms the orphan close."""
    from flow_sdk.compute.providers.desktop import pty_session_manager as psm
    from flow_sdk.server import app

    seen: dict = {}
    original = psm.pty_registry.start_cleanup_task

    async def _spy(*args, **kwargs):
        seen["args"], seen["kwargs"] = args, kwargs
        await original(*args, **kwargs)

    psm.pty_registry.start_cleanup_task = _spy  # the helper imports the module singleton
    try:
        await app._start_pty_parked_reaper()
    finally:
        psm.pty_registry.start_cleanup_task = original

    task = psm.pty_registry._cleanup_task
    assert task is not None and not task.done(), "the loop must be running after startup"
    assert task.get_name() == "pty-parked-reaper"
    # Defaults only: no TTL means the orphan close stays off; no interval or grace is overridden.
    assert seen == {"args": (), "kwargs": {}}

    await psm.pty_registry.stop_cleanup_task()


async def test_on_server_startup_calls_the_helper():
    """The root cause was a defined-but-never-called loop; the startup function must call it."""
    from flow_sdk.server import app

    assert "_start_pty_parked_reaper()" in inspect.getsource(app._on_server_startup)


async def test_shutdown_stops_the_loop(monkeypatch):
    """_shutdown_extras cancels the reaper so a lifespan exit leaves no task behind."""
    from flow_sdk.compute.providers.desktop import pty_session_manager as psm
    from flow_sdk.server import app

    await psm.pty_registry.start_cleanup_task()
    assert not psm.pty_registry._cleanup_task.done()

    # The other teardowns in _shutdown_extras are each wrapped in try/except.
    monkeypatch.setattr(app, "clear_server_info", lambda: None, raising=False)
    await app._shutdown_extras()

    assert psm.pty_registry._cleanup_task.done()
