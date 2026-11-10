"""A setup check must not count Flowpad's own install as something the machine has.

`adopt_path` (core/capabilities/env_probe.py) puts this interpreter's folder FIRST on the backend's
PATH so `flow` stays this build. On a uv-tool install that folder also holds the venv's `python3`,
so once any in-process check had adopted the terminal PATH, every later shell check found a Python
and the setup wizard never offered to install one (first_launch_e2e: python3 still missing).
"""

import os
import sys

from flow_sdk.core.compute_op.runner import check_op
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec

PRINT_PATH = {"win32": "$env:Path", "linux": 'printf %s "$PATH"', "darwin": 'printf %s "$PATH"'}


def _print_path_op() -> ComputeOpSpec:
    return ComputeOpSpec.model_validate(
        {"name": "print-path", "subkind": "cli", "exe_data": {"commands": PRINT_PATH}, "completion_check": {"commands": PRINT_PATH}}
    )


async def test_a_check_sees_the_machines_path_without_flowpads_folder(tmp_path, monkeypatch):
    own = os.path.dirname(sys.executable)
    users = str(tmp_path / "users-bin")
    monkeypatch.setenv("PATH", os.pathsep.join([own, users, os.environ["PATH"]]))

    said = await check_op(_print_path_op(), workdir=tmp_path, platform=sys.platform)

    seen = [os.path.normcase(p) for p in said.stdout.strip().split(os.pathsep)]
    assert os.path.normcase(own) not in seen, "the check can still find Flowpad's own interpreter"
    assert os.path.normcase(users) in seen, "the check lost the user's own PATH entries"
