"""Step 12: Server startup/shutdown wiring.

Verifies that _start_fsop_watcher calls fsop_watcher.start, and that
_shutdown_extras calls fsop_watcher.stop. Stays narrow — full server-boot
integration is out of scope.
"""
from __future__ import annotations

import pytest

from flow_sdk.server.fsop_watcher import FSOpWatcher, fsop_watcher


# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


async def test_fsop_watcher_module_singleton_exposed():
    """The module exposes `fsop_watcher` as a singleton."""
    assert isinstance(fsop_watcher, FSOpWatcher)


async def test_start_helper_invokes_watcher_start(monkeypatch):
    """_start_fsop_watcher must call fsop_watcher.start()."""
    from flow_sdk.server import app
    from flow_sdk.server import fsop_watcher as fw_mod

    called = {"start": False}

    async def _spy_start():
        called["start"] = True

    monkeypatch.setattr(fw_mod.fsop_watcher, "start", _spy_start)

    await app._start_fsop_watcher()
    assert called["start"] is True


async def test_shutdown_invokes_watcher_stop(monkeypatch):
    """_shutdown_extras must call fsop_watcher.stop()."""
    from flow_sdk.server import app
    from flow_sdk.server import fsop_watcher as fw_mod

    called = {"stop": False}

    async def _spy_stop():
        called["stop"] = True

    # Patch out everything else in _shutdown_extras that touches state.
    monkeypatch.setattr(fw_mod.fsop_watcher, "stop", _spy_stop)
    monkeypatch.setattr(app, "clear_server_info", lambda: None, raising=False)
    # Stop hub_ws_manager + scheduler are wrapped in try/except in _shutdown_extras,
    # so even if they fail we still reach the FSOp watcher stop.

    await app._shutdown_extras()
    assert called["stop"] is True


async def test_start_helper_swallows_watcher_failure(monkeypatch):
    """If fsop_watcher.start() raises, _start_fsop_watcher must not propagate
    (server boot should not be blocked by a misbehaving watcher)."""
    from flow_sdk.server import app
    from flow_sdk.server import fsop_watcher as fw_mod

    async def _failing_start():
        raise RuntimeError("watcher init failed")

    monkeypatch.setattr(fw_mod.fsop_watcher, "start", _failing_start)

    # Must not raise
    await app._start_fsop_watcher()
