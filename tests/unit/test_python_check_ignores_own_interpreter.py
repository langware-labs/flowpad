"""Python's install checks must not count Flowpad's own interpreter as "Python 3 is installed".

`adopt_path` (core/capabilities/env_probe.py) puts this interpreter's folder FIRST on the backend's
PATH so `flow` stays this build. On a uv-tool install that folder also holds the venv's `python3`,
so once any in-process check had adopted the terminal PATH, every later shell check found a Python
and the setup wizard never offered to install one (first_launch_e2e: python3 still missing).
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import shutil

import pytest

OPS = Path(__file__).resolve().parents[2] / "flow_sdk/system_projects/flowpad_assistant/agentic-assets/compute_op"


def _check(name: str) -> str:
    return json.loads((OPS / name / "compute_op.json").read_text())["completion_check"]["commands"]["linux"]


def _tools(tmp_path: Path) -> str:
    """A folder with only what the check line calls besides python, so no host Python is on PATH."""
    tools = tmp_path / "tools"
    tools.mkdir()
    for name in ("dirname",):
        (tools / name).symlink_to(shutil.which(name))
    return str(tools)


def _fake_python(folder: Path) -> Path:
    folder.mkdir(parents=True)
    exe = folder / "python3"
    exe.write_text("#!/bin/sh\necho 'Python 3.11.9'\n")
    exe.chmod(0o755)
    return exe


@pytest.mark.skipif(sys.platform == "win32", reason="the linux command is a POSIX shell line")
@pytest.mark.parametrize("op", ["ask-install-python", "python-on-path"])
def test_own_interpreter_folder_is_not_an_installed_python(tmp_path, op):
    own = _fake_python(tmp_path / "flowpad-venv" / "bin")
    env = {"PATH": f"{own.parent}:{_tools(tmp_path)}", "FLOWPAD_PYTHON": str(own.parent / "python")}
    said = subprocess.run(["/bin/sh", "-c", _check(op)], env=env, capture_output=True, text=True)
    assert said.returncode != 0, "Flowpad's own interpreter was taken for the user's Python"


@pytest.mark.skipif(sys.platform == "win32", reason="the linux command is a POSIX shell line")
@pytest.mark.parametrize("op", ["ask-install-python", "python-on-path"])
def test_a_python_of_the_users_still_counts(tmp_path, op):
    own = _fake_python(tmp_path / "flowpad-venv" / "bin")
    users = _fake_python(tmp_path / "usr" / "bin")
    env = {"PATH": f"{own.parent}:{users.parent}:{_tools(tmp_path)}", "FLOWPAD_PYTHON": str(own.parent / "python")}
    said = subprocess.run(["/bin/sh", "-c", _check(op)], env=env, capture_output=True, text=True)
    assert said.returncode == 0, said.stderr
