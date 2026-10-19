"""The shipped diagnose's server-lock check against real lock files.

A stopped or crashed backend can leave ``server.lock`` and a dead ``server.pid`` behind, harmless by
contract (``singleton_lock.release``); only a lock some process still HOLDS can block a start.
"""

import importlib.util
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import flow_sdk

_DEAD_PID = 2**22 + 12345  # above every default pid_max: never a live process


def _check_lock():
    path = Path(flow_sdk.__file__).parent / "system_projects/flowpad_assistant/agentic-assets/diagnose/flowpad/diagnose.py"
    spec = importlib.util.spec_from_file_location("flowpad_diagnose", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.check_lock


def _settings(tmp_path: Path) -> SimpleNamespace:
    return SimpleNamespace(server_lock_path=tmp_path / "server.lock", server_pid_path=tmp_path / "server.pid")


def test_leftover_lock_files_of_a_gone_process_are_not_a_stale_lock(tmp_path):
    settings = _settings(tmp_path)
    settings.server_lock_path.write_text("")
    settings.server_pid_path.write_text(str(_DEAD_PID))

    assert _check_lock()(settings) == []


def test_a_lock_still_held_for_a_process_that_is_gone_is_reported(tmp_path):
    settings = _settings(tmp_path)
    settings.server_pid_path.write_text(str(_DEAD_PID))
    holder = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import sys, time; from filelock import FileLock; lock = FileLock(sys.argv[1]); lock.acquire(); "
            "print('held', flush=True); time.sleep(30)",
            str(settings.server_lock_path),
        ],
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert holder.stdout.readline().strip() == "held"
        findings = _check_lock()(settings)
    finally:
        holder.kill()
        holder.wait()

    assert [f.id for f in findings] == ["A2.lock"]
