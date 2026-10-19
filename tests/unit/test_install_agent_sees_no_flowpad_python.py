"""An install step's agent sees the machine its completion check sees — not Flowpad's own Python.

Every worker's PATH is pinned with this backend's venv bin dir first, so its `flow` matches the
backend (``flow_cli_env_path``). That dir also holds the backend's `python`. The llm-setup wizard's
Python step falls back to an agent, which ran the step's check in its own shell, found Flowpad's
`python` ("Python 3.11.16"), reported the goal already met and installed nothing; the caller's
re-check, from a shell with no Flowpad on PATH, failed. Seen on a clean Windows 11 VM.

So a process launched for a compute op's agent rung (``context_data["compute_op"]``) gets PATH
WITHOUT the backend's interpreter dirs; every other worker keeps the pin. The spawn step then
re-inserts the harness's own bin folder, which for deepagents IS this venv's — the first cut of
this fix stopped at ``apply_worker_env`` and the agent on the VM still found Flowpad's python.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers import apply_worker_env
from flow_sdk.builtin.agentic_process.cli_drivers import cli_worker_base_driver as base_driver
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    build_worker_spawn_env,
    path_without_flowpad_interpreter,
)

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

SEP = os.pathsep
VENV_BIN = str(Path(sys.executable).parent)
ELSEWHERE = str(Path(__file__).resolve().parent)  # a real dir that holds no interpreter
FLOW_EXE = "flow.exe" if sys.platform == "win32" else "flow"


class _Process:
    id = "00000000-0000-4000-8000-000000000001"
    driver = SimpleNamespace(name="deepagents")

    def __init__(self, context_data: dict | None = None):
        self.context_data = context_data or {}

    @staticmethod
    def get_type() -> str:
        return "agentic_process"


def _norm(path: str) -> str:
    return os.path.normcase(os.path.normpath(path))


def test_an_install_agent_gets_no_flowpad_interpreter_on_path():
    env = {"PATH": SEP.join([VENV_BIN, ELSEWHERE])}

    apply_worker_env(env, _Process({"compute_op": "python-on-path"}))

    entries = [_norm(p) for p in env["PATH"].split(SEP)]
    assert _norm(VENV_BIN) not in entries
    assert _norm(ELSEWHERE) in entries, "the rest of the machine's PATH is kept"
    found = shutil.which("python", path=env["PATH"])
    assert found is None or _norm(str(Path(found).parent)) != _norm(VENV_BIN)
    # Flowpad's own interpreter is still reachable by name, for the skills that need it.
    assert env["FLOWPAD_PYTHON"] == sys.executable


@pytest.mark.skipif(not (Path(VENV_BIN) / FLOW_EXE).exists(), reason="no `flow` beside this interpreter to pin")
def test_every_other_worker_keeps_the_flow_pin():
    env = {"PATH": ELSEWHERE}

    apply_worker_env(env, _Process())

    assert env["PATH"].split(SEP)[0] == VENV_BIN


def test_the_base_interpreter_goes_too_and_nothing_else():
    base = str(Path(sys.base_prefix))
    path = SEP.join([base, VENV_BIN, ELSEWHERE, ""])

    assert path_without_flowpad_interpreter(path) == ELSEWHERE


@pytest.mark.skipif(sys.platform != "win32", reason="Windows compares PATH entries case-insensitively")
def test_a_differently_cased_entry_is_still_dropped_on_windows():
    assert path_without_flowpad_interpreter(SEP.join([VENV_BIN.upper(), ELSEWHERE])) == ELSEWHERE


@pytest.mark.parametrize("install_step", [True, False])
def test_the_spawn_step_does_not_bring_it_back(monkeypatch, install_step):
    """deepagents runs in this venv, so its discovered bin folder is the venv's bin dir."""
    monkeypatch.setattr(base_driver, "worker_bin_folder", lambda _worker: VENV_BIN)
    worker_env = apply_worker_env(
        {"PATH": ELSEWHERE}, _Process({"compute_op": "python-on-path"} if install_step else None)
    )

    spawn = build_worker_spawn_env("deepagents", worker_env, base_env={"PATH": ELSEWHERE})

    entries = [_norm(p) for p in spawn["PATH"].split(SEP)]
    if install_step:
        assert _norm(VENV_BIN) not in entries
        assert _norm(ELSEWHERE) in entries
    else:
        assert entries[0] == _norm(VENV_BIN), "an ordinary deepagents worker keeps its bin dir first"
