"""The darwin install command of the ``git-on-path`` compute op, run for real against stand-ins.

The command waits for Apple's installer, which is a person answering a window. Waiting forever on a cancelled or
failed install is the bug this guards: it must stop with a message when the install cannot start, and when the
installer has gone and git still is not there, but keep waiting while the installer is open.

``xcode-select``, ``lsappinfo``, ``open`` and ``sleep`` are small shell scripts on PATH. The installer "being open"
and git "appearing" are driven by how many times the command has asked, so no clock is involved.
"""

import json
import stat
import subprocess
import sys
from pathlib import Path

import pytest

OP = (
    Path(__file__).resolve().parents[2]
    / "flow_sdk/system_projects/flowpad_assistant/agentic-assets/compute_op/git-on-path/compute_op.json"
)

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="a POSIX shell command for macOS")

SHIMS = {
    # `xcode-select -p`: the developer dir once "installed"; `--install`: starts the installer unless told to fail.
    "xcode-select": """#!/bin/sh
case "$1" in
  -p) [ -f "$STATE/installed" ] && { echo "$STATE/dev"; exit 0; }; exit 2 ;;
  --install) echo x >> "$STATE/install_calls"; [ -n "$INSTALL_FAILS" ] && exit 1; exit 0 ;;
esac
""",
    # `lsappinfo find ...`: prints something while the installer is "open". Counts the questions; after
    # GIT_AFTER questions git appears, after OPEN_FOR questions the installer is gone.
    "lsappinfo": """#!/bin/sh
n=$(( $(cat "$STATE/asked" 2>/dev/null || echo 0) + 1 )); echo $n > "$STATE/asked"
[ -n "$GIT_AFTER" ] && [ "$n" -ge "$GIT_AFTER" ] && touch "$STATE/installed"
[ "$n" -le "${OPEN_FOR:-0}" ] && echo 'ASN:0x0-0x1:"Install Command Line Developer Tools":'
exit 0
""",
    "open": """#!/bin/sh
echo "$@" >> "$STATE/open_calls"
""",
    "sleep": """#!/bin/sh
exit 0
""",
}


def _run(tmp_path, **env):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    for name, body in SHIMS.items():
        shim = bindir / name
        shim.write_text(body)
        shim.chmod(shim.stat().st_mode | stat.S_IXUSR)
    state = tmp_path / "state"
    (state / "dev/usr/bin").mkdir(parents=True)
    git = state / "dev/usr/bin/git"
    git.write_text("#!/bin/sh\n")
    git.chmod(0o755)
    command = json.loads(OP.read_text())["exe_data"]["commands"]["darwin"]
    result = subprocess.run(
        ["/bin/sh", "-c", command],
        capture_output=True,
        text=True,
        timeout=20,
        env={"PATH": f"{bindir}:/usr/bin:/bin", "STATE": str(state), **env},
    )

    def calls(name):
        """The lines a shim wrote; for `asked` (a counter), how many times the installer was asked about."""
        path = state / name
        lines = path.read_text().splitlines() if path.exists() else []
        return int(lines[0]) if name == "asked" and lines else lines if name != "asked" else 0

    return result, calls


def test_git_already_there_installs_nothing(tmp_path):
    (tmp_path / "state").mkdir()
    (tmp_path / "state" / "installed").touch()
    result, calls = _run(tmp_path)
    assert result.returncode == 0
    assert calls("install_calls") == [] and calls("open_calls") == []


def test_an_install_that_cannot_start_fails_with_a_message_at_once(tmp_path):
    result, calls = _run(tmp_path, INSTALL_FAILS="1")
    assert result.returncode == 1
    assert "Could not start" in result.stderr and "online" in result.stderr
    assert calls("open_calls") == [], "nothing to bring to the front"
    assert calls("asked") == 0, "it did not start waiting"


def test_a_cancelled_installer_ends_the_wait_with_a_message(tmp_path):
    # Opens for 2 checks (the person looks at it), then is closed and git never arrives.
    result, calls = _run(tmp_path, OPEN_FOR="2")
    assert result.returncode == 1
    assert "closed before git was installed" in result.stderr
    assert "run this setup again" in result.stderr
    # 2 checks while open + 6 consecutive "gone" checks, then it stops: it does not poll on forever.
    assert calls("asked") == 8


def test_an_installer_that_never_appears_is_also_given_up_on(tmp_path):
    result, calls = _run(tmp_path, OPEN_FOR="0")
    assert result.returncode == 1
    assert calls("asked") == 6


def test_a_finished_install_succeeds_and_the_window_was_brought_forward_once(tmp_path):
    result, calls = _run(tmp_path, OPEN_FOR="99", GIT_AFTER="4")
    assert result.returncode == 0
    assert calls("open_calls") == ["-b com.apple.dt.CommandLineTools.installondemand"]
    assert calls("install_calls") == ["x"]


def test_an_open_installer_keeps_the_wait_going_for_a_long_install(tmp_path):
    # Open for 200 checks (far past the 6-check give-up), git arrives at the 150th: must not give up early.
    result, calls = _run(tmp_path, OPEN_FOR="200", GIT_AFTER="150")
    assert result.returncode == 0
    assert calls("asked") == 150
