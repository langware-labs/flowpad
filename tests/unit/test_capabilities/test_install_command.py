"""The install one-liner a capability offers for THIS machine.

``CapabilitySpec.install_commands`` is a per-``sys.platform`` table and
``install_command`` is its resolution. What makes it worth pinning is where the
string ends up: the harness dialog's "Try auto install" TYPES it into a Flowpad
terminal, so the platform must match the shell that terminal spawns and the
command must need nothing preinstalled — these machines have no node, no npm,
and no package manager.
"""

from __future__ import annotations

import sys

import pytest

from flow_sdk.core.capabilities.models import CapabilityKind, CapabilitySpec
from flow_sdk.core.capabilities.registry import get_default_capability_specs


def _spec(kind: str) -> CapabilitySpec:
    return next(s for s in get_default_capability_specs() if s.kind == kind)


def test_resolves_the_running_platform(monkeypatch: pytest.MonkeyPatch) -> None:
    spec = CapabilitySpec(name="X", kind="x", install_commands={"darwin": "mac", "win32": "windows"})

    monkeypatch.setattr(sys, "platform", "darwin")
    assert spec.install_command == "mac"
    monkeypatch.setattr(sys, "platform", "win32")
    assert spec.install_command == "windows"


def test_a_platform_with_no_installer_offers_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    # None is what removes the affordance from the dialog. A capability with no
    # unattended installer here must not show a button that types an empty line.
    monkeypatch.setattr(sys, "platform", "freebsd")
    assert _spec(CapabilityKind.CLAUDE_CLI.value).install_command is None
    assert CapabilitySpec(name="X", kind="x").install_command is None


# Every harness. All four install unattended on unix; Windows is where they
# diverge, so the Windows cases are pinned one at a time below.
HARNESSES = [
    CapabilityKind.CLAUDE_CLI.value,
    CapabilityKind.CODEX_CLI.value,
    CapabilityKind.COPILOT_CLI.value,
    CapabilityKind.OPENCODE_CLI.value,
]

# Each installer picks its own bin directory; there is no shared one to assume.
UNIX_BIN_DIR = {
    CapabilityKind.CLAUDE_CLI.value: "$HOME/.local/bin",
    CapabilityKind.CODEX_CLI.value: "$HOME/.local/bin",
    CapabilityKind.COPILOT_CLI.value: "$HOME/.local/bin",
    CapabilityKind.OPENCODE_CLI.value: "$HOME/.opencode/bin",
}


@pytest.mark.parametrize("kind", HARNESSES)
@pytest.mark.parametrize("platform", ["darwin", "linux"])
def test_every_harness_installs_from_a_bare_machine(monkeypatch: pytest.MonkeyPatch, kind: str, platform: str) -> None:
    monkeypatch.setattr(sys, "platform", platform)
    command = _spec(kind).install_command
    assert command

    # NEVER npm. The whole premise of the affordance is a machine with no node
    # and no package manager, so `npm install -g` — which all four of these
    # also document — would fail on exactly the machines that need it.
    assert "npm" not in command


@pytest.mark.parametrize("kind", HARNESSES)
def test_unix_installers_put_their_bin_dir_on_the_running_shells_path(
    monkeypatch: pytest.MonkeyPatch, kind: str
) -> None:
    # Each installer edits a shell rc file, which never reaches the shell that
    # is ALREADY running — so without the re-export the verify step at the end
    # fails on a perfectly good install. The directory is per-harness (OpenCode
    # keeps its own), which is why this reads from the table rather than
    # assuming a shared one.
    monkeypatch.setattr(sys, "platform", "darwin")
    command = _spec(kind).install_command
    assert command
    assert f'export PATH="{UNIX_BIN_DIR[kind]}:$PATH"' in command
    assert command.rstrip().endswith("--version")


def test_windows_speaks_powershell_and_unix_speaks_sh(monkeypatch: pytest.MonkeyPatch) -> None:
    """The command has to match the shell Flowpad's terminal actually spawns.

    ``compute/providers/desktop/provider.py`` tries pwsh, then powershell, and
    reaches cmd.exe only when neither exists — so PowerShell is the Windows
    dialect. Getting this backwards is not a subtle failure: `irm` in cmd.exe
    and `curl | bash` in PowerShell both die on the first token.
    """
    spec = _spec(CapabilityKind.CLAUDE_CLI.value)

    monkeypatch.setattr(sys, "platform", "win32")
    windows = spec.install_command
    assert windows and windows.startswith("irm ")
    assert "$env:Path" in windows

    monkeypatch.setattr(sys, "platform", "darwin")
    mac = spec.install_command
    assert mac and mac.startswith("curl ")
    assert "irm" not in mac


def test_copilot_on_windows_falls_back_to_winget(monkeypatch: pytest.MonkeyPatch) -> None:
    """The one harness with no PowerShell installer of its own.

    GitHub publishes only WinGet and npm for Windows. WinGet wins because it is
    in-box from Windows 10 1809 while npm implies a whole Node runtime — but it
    also means this is the one command with no PATH line and no verify tail,
    since WinGet's shim directory is already on the running shell's PATH.
    """
    monkeypatch.setattr(sys, "platform", "win32")
    command = _spec(CapabilityKind.COPILOT_CLI.value).install_command
    assert command == "winget install GitHub.Copilot"


def test_opencode_offers_nothing_on_windows(monkeypatch: pytest.MonkeyPatch) -> None:
    """Deliberate absence, not an oversight.

    Every Windows route OpenCode documents — Chocolatey, Scoop, npm, mise,
    Docker — needs a tool installed first, which is precisely the machine this
    affordance exists for. Offering one would hand the user a command that
    fails with a confusing error; a missing key hides the button and leaves the
    homepage link, which is the honest outcome.
    """
    monkeypatch.setattr(sys, "platform", "win32")
    assert _spec(CapabilityKind.OPENCODE_CLI.value).install_command is None
