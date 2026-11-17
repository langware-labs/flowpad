"""``terminate_tree`` survives a wait primitive that refuses a process.

psutil waits on a non-child through ``pidfd_open``; some kernels/sandboxes answer ``EINVAL`` for
one process of a worker tree. The signals are already sent by then, so the kill must still report
what it reaped instead of raising (``flow instance restart-backend`` died this way, p12
``pty_recovery_after_restart``).
"""

from __future__ import annotations

import errno
import subprocess
import sys

import psutil

from flow_sdk.instances import procs


def test_a_refused_wait_falls_back_to_polling_and_still_reaps(monkeypatch):
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:

        def refuse(*_a, **_k):
            raise OSError(errno.EINVAL, "Invalid argument")

        monkeypatch.setattr(psutil, "wait_procs", refuse)
        killed, survivors, refused = procs.terminate_tree([psutil.Process(child.pid)], allow_protected=True)
        child.wait(timeout=5)
        assert killed == [child.pid]
        assert survivors == []
        assert refused == []
    finally:
        if child.poll() is None:
            child.kill()
