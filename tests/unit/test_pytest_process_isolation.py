"""The root pytest harness gives every process a disjoint filesystem sandbox."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

_PROBE_ENV = "FLOWPAD_PYTEST_ISOLATION_PROBE"
_PROBE_MARKER = "__PYTEST_ISOLATION_PROBE__="


def _inside(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def test_pytest_process_isolation_probe(request):
    """Child-only probe of the paths established by the real root conftest."""
    if os.environ.get(_PROBE_ENV) != "1":
        pytest.skip("runs only in the subprocess-isolation regression")

    from flow_sdk.db.drivers.db_driver import _driver_instances
    from flow_sdk.instance_settings import get_instance_settings

    home = Path(os.environ["HOME"])
    run_root = home.parent
    basetemp = Path(request.config.option.basetemp)
    settings = get_instance_settings()
    session_db = Path(_driver_instances["sqlite"].config.database)
    payload = {
        "run_root": str(run_root),
        "home": str(home),
        "path_home": str(Path.home()),
        "userprofile": os.environ["USERPROFILE"],
        "claude_settings": str(settings.claude_settings_json_path),
        "db_env": os.environ["SQLITE_DATABASE_PATH"],
        "records": os.environ["FS_RECORD_PATH"],
        "basetemp": str(basetemp),
        "session_db": str(session_db),
        "temp_base": os.environ["FLOWPAD_TEMP_DIR"],
    }

    assert home == run_root / "home"
    assert Path.home() == home == Path(os.environ["USERPROFILE"])
    assert settings.claude_settings_json_path == home / ".claude" / "settings.json"
    assert Path(payload["db_env"]) == run_root / "flowpad_test.db"
    # The per-test ``isolated_records_root`` fixture narrows the session-level
    # records root further, beneath this process's basetemp.
    assert _inside(Path(payload["records"]), basetemp)
    assert basetemp == run_root / "tmp"
    assert _inside(session_db, basetemp)
    print(_PROBE_MARKER + json.dumps(payload, sort_keys=True), flush=True)


def _child_env(temp_base: Path) -> dict[str, str]:
    env = os.environ.copy()
    real_home = env["FLOWPAD_PRE_SANDBOX_HOME"]
    env["HOME"] = real_home
    env["USERPROFILE"] = real_home
    for key in (
        "FLOWPAD_PRE_SANDBOX_HOME",
        "SQLITE_DATABASE_PATH",
        "FS_RECORD_PATH",
        "FLOW_HOME",
        "FLOWPAD_TEST",
        "FLOWPAD_TEST_SANDBOX",
        "FLOWPAD_CLAUDE_HOME",
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        "PYTEST_CURRENT_TEST",
    ):
        env.pop(key, None)
    env["FLOW_INSTANCE"] = "pytest-isolation-probe"
    env["FLOWPAD_TEMP_DIR"] = str(temp_base)
    env["FLOWPAD_SKIP_DOTENV"] = "true"
    env[_PROBE_ENV] = "1"
    return env


def _probe_payload(output: str) -> dict[str, str]:
    marked = [line for line in output.splitlines() if line.startswith(_PROBE_MARKER)]
    assert len(marked) == 1, output
    return json.loads(marked[0][len(_PROBE_MARKER) :])


def test_two_pytest_processes_have_disjoint_homes_and_state(tmp_path: Path):
    """Two concurrent real pytest sessions never share an owned state path."""
    repo = Path(__file__).resolve().parents[2]
    node = f"{__file__}::test_pytest_process_isolation_probe"
    argv = [sys.executable, "-m", "pytest", "-q", "-s", "--color=no", node]
    env = _child_env(tmp_path / "child-temp")
    processes = [
        subprocess.Popen(
            argv,
            cwd=repo,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        for _ in range(2)
    ]
    completed = [(proc.communicate()[0], proc.returncode) for proc in processes]
    for output, returncode in completed:
        assert returncode == 0, output

    first, second = (_probe_payload(output) for output, _ in completed)
    assert first["run_root"] != second["run_root"]
    assert first["temp_base"] == second["temp_base"] == str(tmp_path / "child-temp")
    isolated_keys = {
        "run_root",
        "home",
        "path_home",
        "userprofile",
        "claude_settings",
        "db_env",
        "records",
        "basetemp",
        "session_db",
    }
    assert {first[key] for key in isolated_keys}.isdisjoint({second[key] for key in isolated_keys})
