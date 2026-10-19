"""POST /api/v1/version/install honours the desktop <-> backend compatibility contract.

A desktop-managed backend (env set by the Electron shell) refuses a target below
the desktop's floor BEFORE installing anything, and rolls the previous version
back when the freshly installed release turns out to require a newer desktop —
an incompatible pair must never be scheduled to boot.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from flow_sdk import __version__
from flow_sdk.server import self_update
from flow_sdk.server.routes import version as version_route
from flow_sdk.server.routes.version import InstallVersionRequest
from flow_sdk.utils import compat


@pytest.fixture
def installable(monkeypatch):
    """A healthy, non-editable install with a live monitor and a fake installer."""
    installed: list[str] = []
    restarts: list[int] = []
    monkeypatch.delenv(compat.ENV_DESKTOP_VERSION, raising=False)
    monkeypatch.delenv(compat.ENV_DESKTOP_MIN_BACKEND, raising=False)
    monkeypatch.setattr(self_update, "is_editable_install", lambda: False)
    monkeypatch.setattr(version_route, "get_status", lambda: {"monitor_alive": True})
    monkeypatch.setattr(
        self_update, "reinstall_version",
        lambda v, timeout=180.0: (installed.append(v), SimpleNamespace(ok=True, detail=None, stdout="", stderr=""))[1],
    )
    monkeypatch.setattr(self_update, "schedule_restart", lambda: restarts.append(1))
    return SimpleNamespace(installed=installed, restarts=restarts)


async def test_refuses_a_target_below_the_desktop_floor_before_installing(monkeypatch, installable):
    monkeypatch.setenv(compat.ENV_DESKTOP_VERSION, "0.2.60")
    monkeypatch.setenv(compat.ENV_DESKTOP_MIN_BACKEND, "0.2.50")

    resp = await version_route._install_version(InstallVersionRequest(version="0.2.40"))

    assert not resp.success and resp.reason == "incompatible_desktop"
    assert "0.2.50" in (resp.error or "")
    assert installable.installed == [] and installable.restarts == []


async def test_rolls_back_when_the_new_release_requires_a_newer_desktop(monkeypatch, installable):
    monkeypatch.setattr(
        self_update, "verify_installed_against_desktop",
        lambda: "the installed backend requires FlowPad Desktop 0.2.60 or newer, but Desktop 0.2.45 is running",
    )

    resp = await version_route._install_version(InstallVersionRequest(version="999.0.0"))

    assert not resp.success and resp.reason == "backend_requires_newer_desktop"
    assert "0.2.60" in (resp.error or "") and "preserved" in (resp.error or "")
    assert installable.installed == ["999.0.0", __version__], "the previous version is put back"
    assert installable.restarts == [], "an incompatible pair is never scheduled to boot"


async def test_a_compatible_install_still_restarts(monkeypatch, installable):
    monkeypatch.setattr(self_update, "verify_installed_against_desktop", lambda: None)

    resp = await version_route._install_version(InstallVersionRequest(version="999.0.0"))

    assert resp.success and resp.restarting
    assert installable.installed == ["999.0.0"] and installable.restarts == [1]


async def test_headless_backends_are_not_constrained(monkeypatch, installable):
    monkeypatch.setattr(self_update, "verify_installed_against_desktop", lambda: None)

    resp = await version_route._install_version(InstallVersionRequest(version="0.0.1"))

    assert resp.success, "no desktop env → no floor, the install proceeds"
