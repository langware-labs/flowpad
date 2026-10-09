"""The darwin Python check of the llm-setup wizard must not wake Apple's developer-tools dialog.

``/usr/bin/python3`` on a Mac is a stub, like ``/usr/bin/git``: until the Command Line Tools are installed, running
it opens a system dialog. The check therefore never runs the ``/usr/bin`` python unless ``xcode-select -p`` names a
directory that holds one; a Python anywhere else is run as before.

The command names ``/usr/bin/python3`` literally, so the test points that literal at a temporary directory: the "stub" is a
script there that leaves a marker if it is ever run, and ``xcode-select`` is a shim that says whether the tools exist.
"""

import json
import stat
import subprocess
import sys
from pathlib import Path

import pytest

OPS = Path(__file__).resolve().parents[2] / "flow_sdk/system_projects/flowpad_assistant/agentic-assets/compute_op"
pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="a POSIX shell command for macOS")


def _command(op: str, stub_dir: Path) -> str:
    command = json.loads((OPS / op / "compute_op.json").read_text())["completion_check"]["commands"]["darwin"]
    # Only the two comparisons that name the stub; `$d/usr/bin/$c` (inside the developer directory) stays as it is.
    return command.replace("= /usr/bin/python3", f"= {stub_dir}/python3").replace(
        "= /usr/bin/python ]", f"= {stub_dir}/python ]"
    )


def _script(path: Path, body: str) -> None:
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def _run(tmp_path, op, *, tools_installed, elsewhere_python=False):
    stub_dir = tmp_path / "usrbin"
    other_dir = tmp_path / "other"
    dev = tmp_path / "dev"
    for d in (stub_dir, other_dir, dev / "usr/bin"):
        d.mkdir(parents=True, exist_ok=True)
    marker = tmp_path / "stub_was_run"
    # The stub, like Apple's: with the tools installed it forwards to their python3; without them it opens the
    # dialog (here: leaves a marker) and prints the xcode-select complaint.
    _script(
        stub_dir / "python3",
        f'[ -x "{dev}/usr/bin/python3" ] && exec "{dev}/usr/bin/python3" "$@"\n'
        f'touch "{marker}"\necho "xcode-select: note: No developer tools were found" >&2\nexit 1\n',
    )
    if tools_installed:  # the tools hold a real python3
        _script(dev / "usr/bin/python3", 'echo "Python 3.9.6"\n')
    if elsewhere_python:  # e.g. Homebrew's
        _script(other_dir / "python3", 'echo "Python 3.12.1"\n')
    _script(
        other_dir / "xcode-select",
        f'[ "$1" = "-p" ] && {{ {"echo " + str(dev) + "; exit 0" if tools_installed else "exit 2"}; }}\nexit 1\n',
    )
    path = f"{other_dir}:{stub_dir}:/usr/bin:/bin" if not elsewhere_python else f"{other_dir}:{stub_dir}:/bin"
    result = subprocess.run(
        ["/bin/sh", "-c", _command(op, stub_dir)], capture_output=True, text=True, timeout=20, env={"PATH": path}
    )
    return result, marker.exists()


@pytest.mark.parametrize("op", ["python-on-path", "ask-install-python"])
def test_the_stub_python_is_never_run_when_the_tools_are_missing(tmp_path, op):
    result, stub_ran = _run(tmp_path, op, tools_installed=False)
    assert result.returncode == 1, "no usable Python found"
    assert not stub_ran, "the /usr/bin stub was run: that opens Apple's installer dialog"


@pytest.mark.parametrize("op", ["python-on-path", "ask-install-python"])
def test_python_from_the_command_line_tools_counts_once_they_are_installed(tmp_path, op):
    result, stub_ran = _run(tmp_path, op, tools_installed=True)
    assert result.returncode == 0, "the Apple-provided Python 3 counts once the tools are installed"
    assert not stub_ran, "the stub forwarded to the tools; it never reached the dialog branch"


@pytest.mark.parametrize("op", ["python-on-path", "ask-install-python"])
def test_a_python_elsewhere_counts_without_the_tools(tmp_path, op):
    result, stub_ran = _run(tmp_path, op, tools_installed=False, elsewhere_python=True)
    assert result.returncode == 0
    assert not stub_ran


def test_the_ask_variant_prints_the_empty_confirm(tmp_path):
    result, _ = _run(tmp_path, "ask-install-python", tools_installed=False, elsewhere_python=True)
    assert result.stdout.strip() == "{}"
