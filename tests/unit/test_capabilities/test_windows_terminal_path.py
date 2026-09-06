"""Windows PATH discovery reads the registry, not this process's stale copy.

A harness installed while the backend is running was invisible until the
backend restarted: the probe returned ``os.environ["PATH"]``, which Windows
fills in once at launch and never refreshes, while the installer writes the new
directory into ``HKCU\\Environment\\Path``. The "Try auto install" button landed
its binary and the very next probe still said "not installed".

Both branches of ``capture_terminal_path`` now answer the same question — what
would a terminal opened RIGHT NOW resolve — which is the only reading under
which a fresh install is discoverable without a restart.

Runs anywhere: ``winreg`` is faked, so these pin the composition rules (order,
expansion, partial failure) on any platform.
"""

from __future__ import annotations

import os
import sys
import types

import pytest

from flow_sdk.core.capabilities import env_probe

MACHINE = r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"
USER = "Environment"


def _fake_winreg(values: dict[tuple[int, str], str]) -> types.ModuleType:
    """A ``winreg`` whose two Path values are whatever the test says.

    A key absent from ``values`` raises ``OSError`` on open, which is how a real
    machine reports a user who has never had a user-PATH entry.
    """
    module = types.ModuleType("winreg")
    module.HKEY_LOCAL_MACHINE = 0  # type: ignore[attr-defined]
    module.HKEY_CURRENT_USER = 1  # type: ignore[attr-defined]

    class _Key:
        def __init__(self, value: str) -> None:
            self.value = value

        def __enter__(self) -> "_Key":
            return self

        def __exit__(self, *_: object) -> None:
            return None

    def open_key(root: int, sub: str) -> _Key:
        if (root, sub) not in values:
            raise OSError("no such key")
        return _Key(values[(root, sub)])

    module.OpenKey = open_key  # type: ignore[attr-defined]
    module.QueryValueEx = lambda key, name: (key.value, 2)  # type: ignore[attr-defined]
    return module


@pytest.fixture
def on_windows(monkeypatch: pytest.MonkeyPatch):
    """Pretend to be Windows, and let each test install its own registry."""
    monkeypatch.setattr(sys, "platform", "win32")

    def install(values: dict[tuple[int, str], str]) -> None:
        monkeypatch.setitem(sys.modules, "winreg", _fake_winreg(values))

    return install


def test_machine_path_comes_before_user_path(on_windows) -> None:
    # The order Windows itself composes them in, and therefore the order that
    # decides which of two installs wins when both provide the same command.
    on_windows({(0, MACHINE): r"C:\Windows\system32", (1, USER): r"C:\Users\me\.local\bin"})

    assert env_probe.capture_terminal_path() == rf"C:\Windows\system32{os.pathsep}C:\Users\me\.local\bin"


def test_sees_a_directory_this_process_never_had(on_windows, monkeypatch: pytest.MonkeyPatch) -> None:
    """The actual bug: the install landed, the process environment did not move."""
    monkeypatch.setenv("PATH", r"C:\Windows\system32")
    on_windows({(0, MACHINE): r"C:\Windows\system32", (1, USER): r"C:\Users\me\.local\bin"})

    assert r"C:\Users\me\.local\bin" in env_probe.capture_terminal_path()


def test_expands_variable_references(on_windows, monkeypatch: pytest.MonkeyPatch) -> None:
    # REG_EXPAND_SZ is the normal type for these values. Windows expands them
    # when it builds a process environment; an unexpanded entry resolves nothing.
    monkeypatch.setenv("USERPROFILE", r"C:\Users\me")
    on_windows({(1, USER): r"%USERPROFILE%\.local\bin"})

    assert env_probe.capture_terminal_path() == r"C:\Users\me\.local\bin"


def test_one_missing_key_does_not_lose_the_other(on_windows) -> None:
    # A user who has never had a user-PATH entry is ordinary, and the machine
    # PATH still answers.
    on_windows({(0, MACHINE): r"C:\Windows\system32"})

    assert env_probe.capture_terminal_path() == r"C:\Windows\system32"


def test_falls_back_to_the_process_path_when_the_registry_is_unreadable(
    on_windows, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Degraded, never empty: a probe that cannot read the registry answers what
    # it does know rather than reporting that nothing is installed.
    monkeypatch.setenv("PATH", r"C:\fallback")
    on_windows({})

    assert env_probe.capture_terminal_path() == r"C:\fallback"


def test_windows_never_spawns_a_shell(on_windows, monkeypatch: pytest.MonkeyPatch) -> None:
    """The cheap branch stays cheap.

    The unix branch spawns a login shell (~400ms measured); this one is two key
    reads. A subprocess creeping in here would put that cost on every sweep.
    """
    monkeypatch.setattr(
        env_probe.subprocess,
        "run",
        lambda *a, **k: pytest.fail("capture_terminal_path spawned a process on Windows"),
    )
    on_windows({(1, USER): r"C:\Users\me\.local\bin"})

    assert env_probe.capture_terminal_path() == r"C:\Users\me\.local\bin"
