"""Repo-wide pytest fixtures (apply to tests/unit AND tests/long_tests)."""
from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _no_ambient_worker_signal(monkeypatch):
    """Strip ``FLOWPAD_WORKER`` from every test's environment.

    FLOWPAD-2112: that variable marks a FlowPad worker and drives the self-protection lifecycle
    gate (``flow stop`` / ``flow instance reset`` refuse a worker reaping its own backend). It is
    inherited by every child of a worker — including a ``pytest`` an agent session launches — so a
    suite run inside a worker would otherwise carry it and trip the gate (e.g.
    ``test_server_launch_monitor.py`` calling ``_stop_all_guarded`` directly). CI has no worker, so
    this never surfaces there; clearing it unconditionally keeps the tests hermetic regardless of
    where they run. The gate's own tests set the variable explicitly.
    """
    monkeypatch.delenv("FLOWPAD_WORKER", raising=False)
