"""The Windows install commands, pinned at the document level.

These are PowerShell one-liners inside JSON, run on somebody's machine behind an Install button, and
nothing else exercises their text on a Mac or a Linux CI image. What can be pinned from here is the SHAPE
that kept going wrong on Windows:

* **A retry that cannot fix anything is a second permission prompt.** A person who answers "No" to the
  Windows prompt must not be asked again by the command's own fallback — it retries only for winget's own
  source failing, never for a refusal.
* **Nothing that ships may need administrator rights.** A package with a per-user installer takes it
  first (Python). Git has none — the full installer opens a Windows permission prompt even with
  `--scope user`, measured on a Windows VM — so it ships as the portable MinGit.
* **"Already installed" with the tool missing is repaired, not reported.** winget answers 0x8A15002B
  when its record says the package is installed — even when the files were deleted — and a plain
  install does nothing. Only that answer re-runs with `--force`.
* **Node's zip is checked before it is unpacked,** and a half-unpacked folder is not "installed".
* **One line means no PowerShell comment:** a ``#`` would comment out the rest of the command.
"""

from __future__ import annotations

import json

import pytest

from flow_sdk.config import system_projects_root

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

OPS_DIR = system_projects_root() / "flowpad_assistant" / "agentic-assets" / "compute_op"

#: winget's own exit codes (doc/windows/package-manager/winget/returnCodes.md), as PowerShell reads them.
SOURCE_ERRORS = ("-1978335138", "-1978335210", "-1978335163", "-1978335157")
NO_PER_USER_INSTALLER = "-1978335216"  # NO_APPLICABLE_INSTALLER
CANCELLED_BY_USER = "-1978334964"  # INSTALL_CANCELLED_BY_USER
ALREADY_INSTALLED = "-1978335189"  # UPDATE_NOT_APPLICABLE: "found an existing package", nothing newer


def _op(name: str) -> dict:
    return json.loads((OPS_DIR / name / "compute_op.json").read_text())


def _win32(name: str) -> str:
    return _op(name)["exe_data"]["commands"]["win32"]


WINGET_OPS = ("git-on-path", "python-on-path", "vcredist-installed")
PER_USER_OPS = ("python-on-path",)


@pytest.mark.parametrize("name", WINGET_OPS)
def test_winget_retries_only_when_its_own_source_failed(name):
    command = _win32(name)

    assert "--source winget" in command or "'--source','winget'" in command
    assert "$srcErr -contains $c" in command, "the retry has to be gated on a reason, not on 'it failed'"
    for code in SOURCE_ERRORS:
        assert code in command
    # An unconditional `if ($LASTEXITCODE -ne 0) { winget ... }` is what turned "No" into a second prompt.
    assert "$LASTEXITCODE -ne 0" not in command
    assert CANCELLED_BY_USER not in command, "a refusal is an answer; nothing may retry it"


@pytest.mark.parametrize("name", ("python-on-path", "vcredist-installed"))
def test_an_installer_winget_calls_already_done_is_run_again_with_force(name):
    """The record says installed, the files are gone (deleted by hand, quarantined): `winget install` exits
    0x8A15002B and installs nothing, so the check still fails and the ladder goes to an agent that may not
    exist. For an installer package, `--force` runs the installer again. Gated on that one answer, never added
    to the first attempt."""
    command = _win32(name)

    assert f"if ($c -eq {ALREADY_INSTALLED}) {{ winget @base @src @scp --force; $c = $LASTEXITCODE }}" in command
    assert command.count("--force") == 1
    assert command.index("--force") > command.index(f"$c -eq {ALREADY_INSTALLED}")
    assert "'--force'" not in command, "not part of the base arguments every attempt shares"


def test_a_portable_git_winget_calls_already_done_is_uninstalled_and_installed_again():
    """MinGit is a portable package: winget's record also holds its alias in WinGet\\Links. `--force` puts the
    files back but NOT the alias (measured on a Windows VM: git.exe returns, Links stays empty, `git` is not on
    PATH, the check still fails). Uninstalling first forgets the record, and the install then recreates both."""
    command = _win32("git-on-path")

    reinstall = (
        f"if ($c -eq {ALREADY_INSTALLED}) {{ winget uninstall --id Git.MinGit -e --silent --disable-interactivity @src;"
        " winget @base @src @scp; $c = $LASTEXITCODE }"
    )
    assert reinstall in command
    assert "--force" not in command
    assert command.count("uninstall") == 1


@pytest.mark.parametrize("name", PER_USER_OPS)
def test_a_package_with_a_per_user_installer_takes_it_first(name):
    command = _win32(name)

    assert "$scp = @('--scope','user')" in command
    # Only a package with no per-user installer falls back to machine-wide (and so to the prompt).
    assert f"$c -eq {NO_PER_USER_INSTALLER}" in command


def test_git_is_the_portable_mingit_because_the_full_installer_always_prompts():
    """`winget install Git.Git` showed a UAC prompt in a non-elevated session even with `--scope user`: its manifest
    declares both scopes with identical switches, and the installer asks for elevation either way. `Git.MinGit` is a
    portable zip — 0 prompts, 10.8s on the same VM."""
    command = _win32("git-on-path")

    assert "'Git.MinGit'" in command and "Git.Git" not in command
    assert "--scope" not in command, "a portable zip has no machine/user split to choose between"
    assert "$srcErr -contains $c" in command, "it keeps the gated retry"


def test_vcredist_stays_machine_wide_because_it_has_no_per_user_installer():
    command = _win32("vcredist-installed")

    assert "--scope" not in command and "$scp = @()" in command
    assert f"$c -eq {NO_PER_USER_INSTALLER}" not in command


def test_node_and_npm_run_the_same_script():
    """npm ships inside Node's zip, so its Windows step IS Node's. Two copies would drift."""
    assert _win32("node-on-path") == _win32("npm-on-path")


def test_nodes_zip_is_verified_and_a_partial_unpack_is_not_installed():
    command = _win32("node-on-path")

    assert "SHASUMS256.txt" in command and "Get-FileHash" in command
    assert command.index("Get-FileHash") < command.index("Expand-Archive"), "verify BEFORE unpacking"
    assert "SHA256 mismatch" in command
    assert "npm.cmd" in command, "'installed' means node AND npm are there, not node.exe alone"
    assert "Tls12" in command
    assert "ForEach-Object { $_ }" in command, (
        "Windows PowerShell 5.1 hands a JSON array down the pipeline as one object"
    )


@pytest.mark.parametrize("name", WINGET_OPS + ("node-on-path", "npm-on-path"))
def test_a_one_line_command_has_no_powershell_comment(name):
    command = _win32(name)

    assert "\n" not in command
    assert "#" not in command, "a '#' in a one-line command comments out everything after it"


def test_no_shipped_windows_command_asks_for_the_store_python_alias():
    """`python3` on a stock Windows is the Microsoft Store alias stub: it fails even when Python is installed.
    `python3-on-path` checked exactly that and was shipped to nobody — this keeps it from coming back."""
    for op in sorted(OPS_DIR.iterdir()):
        spec = json.loads((op / "compute_op.json").read_text())
        for section in (spec["exe_data"], spec.get("completion_check") or {}):
            command = (section.get("commands") or {}).get("win32", "")
            assert "python3" not in command, f"{op.name}: its Windows command asks for the Store alias `python3`"


def test_no_shipped_windows_command_has_a_double_quote():
    """The runner starts `powershell -Command <text>` as an argument list; Windows quoting then strips the
    `"` of a string literal, so `$name = "node-$v-win"` becomes a command to run. The Node command broke that way
    on a Windows VM — exit 0 with nothing installed, or a Remove-Item argument error — while passing every test
    that fed it to PowerShell as EncodedCommand. Single quotes and `+` survive, so that is all they use."""
    for op in sorted(OPS_DIR.iterdir()):
        spec = json.loads((op / "compute_op.json").read_text())
        for where, section in (("call", spec["exe_data"]), ("check", spec.get("completion_check") or {})):
            command = (section.get("commands") or {}).get("win32", "")
            assert '"' not in command, f"{op.name} ({where}): a double quote in a Windows command"


@pytest.mark.parametrize("name", ("node-on-path", "npm-on-path"))
def test_node_deletes_its_zip_without_remove_item(name):
    """Windows PowerShell 5.1's Remove-Item cannot delete a file by its 8.3 short path — and a short TEMP
    (`C:\\Users\\ADMINI~1\\AppData\\Local\\Temp`, the default for a user name over 8 characters or with a
    space) is what a backend started by the Task Scheduler or a service sees. "An object at the specified path
    C:\\Users\\TEST11~1 does not exist" failed the install AFTER it had downloaded and unpacked Node, even with
    -LiteralPath. [IO.File]::Delete takes the same path."""
    command = _win32(name)

    assert "Remove-Item $zip" not in command
    assert command.count("[IO.File]::Delete($zip)") == 2, "the checksum-mismatch branch and the normal one"
