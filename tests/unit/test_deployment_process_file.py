"""A local deployment is a Python file run in a terminal; who runs it is a lock.

The file is plain Python the person can read and edit — by default two lines running the stock loop
for this deployment. The loop holds the deployment's lock while it runs, so a second copy (typed
twice, run by hand) leaves at once, and "is it running" never mistakes a recycled pid for it.
"""
from __future__ import annotations

import subprocess
import sys
import textwrap
import time
import types
import uuid

import pytest

from flow_sdk.builtin import deployment_process

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.fixture
def deployment(tmp_path, monkeypatch):
    monkeypatch.setattr(deployment_process, "_home", lambda: tmp_path)
    return types.SimpleNamespace(id=str(uuid.uuid4()), snippet=None, name="Mix (local)", provider_labels={})


def _holder(deployment) -> subprocess.Popen:
    """Another process holding the deployment's lock, as a running loop does."""
    code = textwrap.dedent(f"""
        import sys, time
        from flow_sdk.builtin import deployment_process
        deployment_process._home = lambda: __import__("pathlib").Path({str(deployment_process._home())!r})
        lock = deployment_process.hold({deployment.id!r})
        print("held" if lock else "refused", flush=True)
        time.sleep(30)
    """)
    proc = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, text=True)
    assert proc.stdout.readline().strip() == "held"
    return proc


def test_the_stock_file_runs_this_deployment_and_is_written_once(deployment):
    path = deployment_process.file_of(deployment)

    assert path.read_text().count(f'main("{deployment.id}")') == 1
    path.write_text("# edited\n")
    assert deployment_process.file_of(deployment).read_text() == "# edited\n", "an edited file is never rewritten"
    assert deployment_process.command_of(deployment).endswith(f"{path} {deployment.id}")


def test_a_deployment_of_its_own_runs_its_own_file(deployment, tmp_path):
    deployment.snippet = str(tmp_path / "mine.py")

    assert deployment_process.file_of(deployment) == tmp_path / "mine.py"


def test_the_lock_says_who_runs_it_and_refuses_a_second_copy(deployment):
    assert not deployment_process.alive(deployment)
    holder = _holder(deployment)
    try:
        assert deployment_process.pid_of(deployment) == holder.pid
        assert deployment_process.hold(deployment.id) is None, "a second copy is refused"

        assert deployment_process.stop(deployment)
        holder.wait(timeout=5)
        assert not deployment_process.alive(deployment), "a stopped loop frees the lock"
    finally:
        holder.kill()

    mine = deployment_process.hold(deployment.id)
    assert mine is not None, "and the next one takes it"
    mine.close()


def test_a_loop_still_importing_is_found_by_its_command_line(deployment):
    starting = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)", deployment.id])
    try:
        for _ in range(100):
            if deployment_process.pid_of(deployment) is not None:
                break
            time.sleep(0.01)
        assert deployment_process.pid_of(deployment) == starting.pid
    finally:
        starting.kill()
