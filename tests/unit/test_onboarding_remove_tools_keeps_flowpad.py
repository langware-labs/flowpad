"""The dev Reset (``POST /api/v1/graph/compute_node/@local/remove-tools``) never removes Flowpad's own python.

The server puts its own interpreter folder first on PATH, so a plain ``which python3`` answered
Flowpad's venv python and Reset deleted it: the built-in harness lost its executable, every LLM
source was refused ``not_installed``, and the setup wizard asked for a source after sign-in.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from flow_sdk.server.routes import bootstrap


def _exe(folder: Path, name: str) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / name
    path.write_text("#!/bin/sh\n")
    path.chmod(0o755)
    return path


def test_flowpads_venv_python_is_passed_over_for_the_users(tmp_path, monkeypatch):
    venv = tmp_path / "flowpad-venv"
    own = _exe(venv / "bin", "python3")
    users = _exe(tmp_path / "brew" / "bin", "python3")
    monkeypatch.setattr(sys, "prefix", str(venv))

    found, kept_own = bootstrap._which_users_tool("python3", os.pathsep.join([str(own.parent), str(users.parent)]))

    assert found == str(users)
    assert kept_own is True


def test_only_flowpads_python_on_path_finds_nothing(tmp_path, monkeypatch):
    venv = tmp_path / "flowpad-venv"
    own = _exe(venv / "bin", "python3")
    monkeypatch.setattr(sys, "prefix", str(venv))

    assert bootstrap._which_users_tool("python3", str(own.parent)) == (None, True)


def test_the_interpreter_flowpad_runs_on_is_its_own(tmp_path, monkeypatch):
    base = _exe(tmp_path / "uv-python" / "bin", "python3.11")
    link = tmp_path / "uv-python" / "bin" / "python3"
    link.symlink_to(base)
    monkeypatch.setattr(sys, "prefix", str(tmp_path / "flowpad-venv"))
    monkeypatch.setattr(sys, "executable", str(base))

    assert bootstrap._is_flowpads_own(link) is True


def test_an_unrelated_tool_is_still_found(tmp_path, monkeypatch):
    node = _exe(tmp_path / "brew" / "bin", "node")
    monkeypatch.setattr(sys, "prefix", str(tmp_path / "flowpad-venv"))

    assert bootstrap._which_users_tool("node", str(node.parent)) == (str(node), False)
