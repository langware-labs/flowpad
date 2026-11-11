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
        lambda v, timeout=180.0, offline=False: (installed.append(v), SimpleNamespace(ok=True, detail=None, stdout="", stderr=""))[1],
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


# ── the shared verify→rollback helper (route, `flow upgrade`, Windows relay) ─────────────────

def test_rollback_helper_is_silent_for_a_compatible_pair(monkeypatch, installable):
    monkeypatch.setattr(self_update, "verify_installed_against_desktop", lambda: None)

    assert self_update.rollback_if_incompatible("0.2.40") is None
    assert installable.installed == []


def test_rollback_helper_restores_the_previous_version_and_says_why(monkeypatch, installable):
    monkeypatch.setattr(self_update, "verify_installed_against_desktop", lambda: "needs Desktop 0.2.60")

    rolled = self_update.rollback_if_incompatible("0.2.40")

    assert rolled.reason == "needs Desktop 0.2.60" and rolled.restored
    assert installable.installed == ["0.2.40"]
    assert rolled.manual_command.endswith("flowpad==0.2.40")


def test_rollback_helper_reports_a_failed_restore_with_the_manual_command(monkeypatch, installable):
    monkeypatch.setattr(self_update, "verify_installed_against_desktop", lambda: "needs Desktop 0.2.60")
    monkeypatch.setattr(
        self_update, "reinstall_version",
        lambda v, timeout=180.0, offline=False: SimpleNamespace(ok=False, detail="boom", stdout="", stderr=""),
    )

    rolled = self_update.rollback_if_incompatible("0.2.40")

    assert not rolled.restored and "flowpad==0.2.40" in rolled.manual_command


def test_the_windows_relay_rolls_back_an_incompatible_install(monkeypatch, installable, tmp_path):
    """``upgrade_after_exit`` is the detached half of ``flow upgrade`` on Windows: it must apply the same
    verify→rollback as the route, and say so in its log (the only place the user can read the outcome)."""
    import contextlib
    import subprocess

    monkeypatch.setattr(self_update, "_wait_for_exit", lambda pids, timeout: None)
    monkeypatch.setattr(self_update, "launchers_set_aside", lambda wait_s=0.0: contextlib.nullcontext(True))
    monkeypatch.setattr(self_update, "build_install_command", lambda v, offline=False: ["uv", "tool", "install", f"flowpad=={v}"])
    monkeypatch.setattr(subprocess, "run", lambda cmd, **kw: subprocess.CompletedProcess(cmd, 0, "installed", ""))
    monkeypatch.setattr(self_update, "verify_installed_against_desktop", lambda: "needs Desktop 0.2.60")
    log = tmp_path / "upgrade.log"

    code = self_update.upgrade_after_exit("999.0.0", [1], log)

    assert code == 1
    assert installable.installed == [__version__], "the previous version is put back"
    text = log.read_text(encoding="utf-8")
    assert "not compatible with the running desktop" in text and "0.2.60" in text and f"{__version__} was restored" in text


def test_the_windows_relay_keeps_a_compatible_install(monkeypatch, installable, tmp_path):
    import contextlib
    import subprocess

    monkeypatch.setattr(self_update, "_wait_for_exit", lambda pids, timeout: None)
    monkeypatch.setattr(self_update, "launchers_set_aside", lambda wait_s=0.0: contextlib.nullcontext(True))
    monkeypatch.setattr(self_update, "build_install_command", lambda v, offline=False: ["uv", "tool", "install", f"flowpad=={v}"])
    monkeypatch.setattr(subprocess, "run", lambda cmd, **kw: subprocess.CompletedProcess(cmd, 0, "installed", ""))
    monkeypatch.setattr(self_update, "verify_installed_against_desktop", lambda: None)
    log = tmp_path / "upgrade.log"

    assert self_update.upgrade_after_exit("999.0.0", [1], log) == 0
    assert installable.installed == [] and "flowpad upgraded to 999.0.0." in log.read_text(encoding="utf-8")


# ── the restore: cache first, network second; and the relay's compat import happens BEFORE the install ──────

def _restore_script(monkeypatch, outcomes, *, same_command_offline=False):
    """Stand in for reinstall_version with a scripted sequence of results, recording (version, offline) calls."""
    calls: list[tuple[str, bool]] = []
    results = iter(outcomes)

    def fake(version, timeout=180.0, offline=False):
        calls.append((version, offline))
        return SimpleNamespace(ok=next(results), detail=None, stdout="", stderr="")

    monkeypatch.setattr(self_update, "reinstall_version", fake)
    monkeypatch.setattr(
        self_update, "build_install_command",
        lambda v, offline=False: ["uv", "tool", "install", f"flowpad=={v}"] + (["--offline"] if offline and not same_command_offline else []),
    )
    monkeypatch.setattr(self_update, "verify_installed_against_desktop", lambda: "needs Desktop 0.2.60")
    return calls


def test_the_restore_comes_from_uvs_cache_without_touching_the_network(monkeypatch):
    calls = _restore_script(monkeypatch, [True])

    rolled = self_update.rollback_if_incompatible("0.2.40")

    assert rolled.restored and calls == [("0.2.40", True)], "one offline attempt, no network"


def test_the_restore_falls_back_to_the_network_when_the_cache_cannot_serve_it(monkeypatch):
    calls = _restore_script(monkeypatch, [False, True])

    rolled = self_update.rollback_if_incompatible("0.2.40")

    assert rolled.restored and calls == [("0.2.40", True), ("0.2.40", False)]


def test_a_restore_that_fails_both_ways_says_so_and_how_to_do_it_by_hand(monkeypatch):
    calls = _restore_script(monkeypatch, [False, False])

    rolled = self_update.rollback_if_incompatible("0.2.40+local1")

    assert not rolled.restored and len(calls) == 2
    assert rolled.manual_command.endswith("flowpad==0.2.40+local1") and "--offline" not in rolled.manual_command


def test_pip_has_no_cache_only_mode_so_it_gets_one_attempt(monkeypatch):
    calls = _restore_script(monkeypatch, [True], same_command_offline=True)

    rolled = self_update.rollback_if_incompatible("0.2.40")

    assert rolled.restored and calls == [("0.2.40", False)]


def test_offline_is_a_uv_only_spelling():
    uv = self_update.shutil.which("uv")
    if not uv:
        pytest.skip("uv is not on PATH")
    assert self_update.build_install_command("1.2.3", offline=True)[-1] == "--offline"
    assert "--offline" not in self_update.build_install_command("1.2.3")


def test_the_windows_relay_loads_compat_before_the_install_replaces_the_files(monkeypatch, installable, tmp_path):
    """The post-install check runs in the relay process; a FIRST import after the install would run the new
    release's compat module, and a renamed function there would kill the detached relay with no log.
    (A spy on import_module, not surgery on sys.modules: re-importing rebinds the package attribute and would
    leak into every later test.)"""
    import contextlib
    import importlib
    import subprocess

    imported: list[str] = []
    real_import = importlib.import_module
    monkeypatch.setattr(importlib, "import_module", lambda name, *a, **kw: (imported.append(name), real_import(name, *a, **kw))[1])
    at_install: list[bool] = []

    def fake_install(cmd, **kw):
        at_install.append("flow_sdk.utils.compat" in imported)
        return subprocess.CompletedProcess(cmd, 0, "installed", "")

    monkeypatch.setattr(self_update, "_wait_for_exit", lambda pids, timeout: None)
    monkeypatch.setattr(self_update, "launchers_set_aside", lambda wait_s=0.0: contextlib.nullcontext(True))
    monkeypatch.setattr(self_update, "build_install_command", lambda v, offline=False: ["uv", "tool", "install", f"flowpad=={v}"])
    monkeypatch.setattr(subprocess, "run", fake_install)
    monkeypatch.setattr(self_update, "verify_installed_against_desktop", lambda: None)

    assert self_update.upgrade_after_exit("999.0.0", [1], tmp_path / "upgrade.log") == 0
    assert at_install == [True], "compat was requested before the install ran"
