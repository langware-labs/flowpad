"""``single_run``: a script that writes many rows gets the whole run to itself -- across processes."""

from __future__ import annotations

import subprocess
import sys

import pytest

from flow_sdk.datasets.run import RunBusy, run_lock_path, single_run

pytestmark = pytest.mark.timeout(10)

HOLD = """
import sys, time
from flow_sdk.datasets.run import single_run
with single_run(sys.argv[1], "crm-sync"):
    print("held", flush=True)
    sys.stdin.readline()          # until the test lets go
"""


def test_a_second_run_in_this_process_is_refused_or_let_in_after(tmp_path):
    with single_run(tmp_path, "crm-sync"):
        with pytest.raises(RunBusy, match="crm-sync"):
            with single_run(tmp_path, "crm-sync", wait=False):
                pass
        with single_run(tmp_path, "other-script", wait=False):   # another script's run is its own
            pass
    with single_run(tmp_path, "crm-sync", wait=False):           # released: the next run starts
        pass
    assert run_lock_path(tmp_path, "crm-sync") == tmp_path / ".flow/runs/crm-sync.lock"


def test_the_lock_is_released_when_the_run_fails(tmp_path):
    with pytest.raises(ZeroDivisionError):
        with single_run(tmp_path, "crm-sync"):
            1 / 0
    with single_run(tmp_path, "crm-sync", wait=False):
        pass


def test_a_run_in_another_process_holds_it(tmp_path):
    other = subprocess.Popen([sys.executable, "-c", HOLD, str(tmp_path)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    try:
        assert other.stdout.readline().strip() == "held"
        with pytest.raises(RunBusy):
            with single_run(tmp_path, "crm-sync", wait=False):
                pass
    finally:
        other.stdin.write("\n")
        other.stdin.close()
        other.wait()
    with single_run(tmp_path, "crm-sync", wait=False):           # the other process ended: free again
        pass


@pytest.mark.parametrize("bad", ["../escape", "Has Space", ""])
def test_a_name_that_cannot_be_a_file_name_is_refused(tmp_path, bad):
    with pytest.raises(ValueError):
        with single_run(tmp_path, bad):
            pass
