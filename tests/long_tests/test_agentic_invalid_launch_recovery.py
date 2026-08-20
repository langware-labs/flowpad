"""Real-process regression for a malformed Codex PTY launch.

The scenario runs in a child process because the regression blocks inside
``ptyprocess``'s fork/exec error handshake. Cancelling the awaiting coroutine
does not stop that executor thread, so an in-process timeout would wedge the
pytest session instead of reporting a bounded failure.

No system-under-test boundary is replaced: the child uses the real SQLite
driver, AgenticProcess, Shell, ComputeNode, LocalComputeProvider, Codex command,
and PTY implementation.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import traceback
from pathlib import Path
from uuid import uuid4

import pytest

_CHILD_FLAG = "--run-real-agentic-scenario"
_RESULT_PREFIX = "C15_RESULT="
_SCENARIO_TIMEOUT_SECONDS = 15


async def _run_real_agentic_scenario(root: Path) -> dict:
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.builtin.faas.compute_node import ComputeNode
    from flow_sdk.builtin.process_lifecycle import ProcessStatus
    from flow_sdk.builtin.project import Project
    from flow_sdk.builtin.shell import Shell
    from flow_sdk.db.db_entity import DBEntity
    from flow_sdk.db.db_relationship import DBRelationship
    from flow_sdk.db.drivers.db_driver import DBConfig, _driver_instances
    from flow_sdk.db.drivers.sqlite import SQLiteDBDriver
    from flow_sdk.responses.response import ApiFailResponse

    root.mkdir(parents=True, exist_ok=True)
    workdir = root / "workdir"
    workdir.mkdir()

    driver = SQLiteDBDriver(DBConfig(database=str(root / "flowpad.db")))
    _driver_instances["sqlite"] = driver
    DBEntity._db = driver
    DBRelationship._db = driver
    await driver.open()

    process: AgenticProcess | None = None
    try:
        project = Project(
            name="C15 real AgenticProcess",
            fs_storage_mount_path=str(workdir),
        )
        await project.save()
        compute_node = await ComputeNode.get_local()
        assert compute_node is not None

        process = AgenticProcess(
            worker_type="codex",
            project_id=project.id,
            workdir=str(workdir),
            session_id=str(uuid4()),
            status=ProcessStatus.STOPPED.value,
            visible=False,
            pty_mode=False,
            load_flowpad_assistant=False,
            cli_config={
                "worker_type": "codex",
                "env_vars": {},
                "permission_mode": "bypassPermissions",
            },
        )
        await process.save()

        # This is the real durable state produced after terminal -> chat: the
        # process is stopped/headless while its idle Shell row is preserved.
        shell = await process._get_or_create_shell()
        process.shell_id = shell.id
        await process.save()
        baseline_shell_id = shell.id
        baseline_session_id = process.session_id

        process.cli_config = {
            **process.cli_config,
            "env_vars": {"C15_BAD": "before\x00after"},
        }
        await process.save()

        result = await process.start_pty(visible=True, retry=True)
        assert isinstance(result, ApiFailResponse), result
        assert "embedded NUL" in result.message

        reloaded = await AgenticProcess.get_by_id(process.id)
        assert reloaded is not None
        reloaded_shell = await Shell.get_by_id(baseline_shell_id)
        assert reloaded_shell is not None

        return {
            "message": result.message,
            "process_status": reloaded.status,
            "visible": reloaded.visible,
            "pty_mode": reloaded.pty_mode,
            "shell_id_stable": reloaded.shell_id == baseline_shell_id,
            "session_id_stable": reloaded.session_id == baseline_session_id,
            "shell_status": reloaded_shell.status,
            "pty_attachable": await reloaded_shell.has_attachable_pty(),
            "worker_alive": await reloaded_shell.worker_alive(),
        }
    finally:
        if process is not None:
            persisted = await AgenticProcess.get_by_id(process.id)
            if persisted is not None and persisted.shell_id:
                shell = await Shell.get_by_id(persisted.shell_id)
                if shell is not None:
                    await shell.stop()
        await driver.close()


def _child_main(root: Path) -> int:
    import asyncio

    try:
        result = asyncio.run(_run_real_agentic_scenario(root))
    except BaseException:
        traceback.print_exc()
        return 1
    print(f"{_RESULT_PREFIX}{json.dumps(result, sort_keys=True)}", flush=True)
    return 0


def _kill_process_group(process: subprocess.Popen[str]) -> None:
    if sys.platform == "win32":
        process.kill()
        return
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


@pytest.mark.skipif(sys.platform == "win32", reason="ptyprocess reproduction is POSIX-only")
# Codex is an optional, separately-installed worker CLI (CapabilityKind.CODEX_CLI).
# The regression needs the real binary to reach ptyprocess's fork/exec handshake, so
# guard on availability the way every other codex-spawn test in the repo does
# (tests/api/test_pty_process_e2e.py::requires_codex,
# tests/long_tests/test_cli_driver_binary_smoke.py). Hard-asserting here turned a
# missing optional dependency into a red failure on any host without codex.
@pytest.mark.skipif(shutil.which("codex") is None, reason="codex CLI not installed")
def test_malformed_codex_launch_returns_without_stranding_process(tmp_path: Path) -> None:

    child_root = tmp_path / "child"
    child_home = child_root / "home"
    repo_root = Path(__file__).resolve().parents[2]
    child_home.mkdir(parents=True)
    env = os.environ.copy()
    env.update(
        {
            "HOME": str(child_home),
            "SQLITE_DATABASE_PATH": str(child_root / "flowpad.db"),
            "FS_RECORD_PATH": str(child_root / "records"),
            "FLOW_HOME": str(child_root / "flow-home"),
            "FLOW_INSTANCE": "c15-real-agentic",
            "FLOWPAD_DISABLE_VENDORED_FLOW_RS": "1",
            "PYTHONPATH": str(repo_root),
            "TESTING": "true",
        }
    )
    env.pop("PYTEST_CURRENT_TEST", None)

    process = subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), _CHILD_FLAG, str(child_root)],
        cwd=repo_root,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=_SCENARIO_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        _kill_process_group(process)
        stdout, stderr = process.communicate()
        pytest.fail(
            "real AgenticProcess launch did not return within "
            f"{_SCENARIO_TIMEOUT_SECONDS}s; malformed PTY environment stranded "
            "the process in STARTING\n"
            f"stdout:\n{stdout[-2000:]}\n"
            f"stderr:\n{stderr[-4000:]}"
        )

    assert process.returncode == 0, (
        f"real AgenticProcess scenario exited {process.returncode}\n"
        f"stdout:\n{stdout[-2000:]}\n"
        f"stderr:\n{stderr[-4000:]}"
    )
    result_line = next(
        (line for line in stdout.splitlines() if line.startswith(_RESULT_PREFIX)),
        None,
    )
    assert result_line is not None, f"child emitted no result\nstdout:\n{stdout}\nstderr:\n{stderr}"
    result = json.loads(result_line.removeprefix(_RESULT_PREFIX))

    assert result == {
        "message": "PTY environment value for 'C15_BAD' contains an embedded NUL",
        "process_status": "failed",
        "pty_attachable": False,
        "pty_mode": False,
        "session_id_stable": True,
        "shell_id_stable": True,
        "shell_status": "idle",
        "visible": False,
        "worker_alive": False,
    }


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == _CHILD_FLAG:
        raise SystemExit(_child_main(Path(sys.argv[2])))
    raise SystemExit(f"usage: {Path(__file__).name} {_CHILD_FLAG} <temp-root>")
