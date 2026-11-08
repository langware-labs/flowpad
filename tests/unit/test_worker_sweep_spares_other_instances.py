"""A shell's worker sweep kills only its own instance's workers for the session.

2026-11-07: a prodit copy shares prod's session ids, and every terminal it opened SIGTERMed
prod's live worker for that session (13 kills, one mid-turn) because the sweep matched argv
alone. Two real processes carry the same ``--resume <sid>``; only the one pinned to this
instance's ``FLOW_INSTANCE`` is a victim.
"""

from __future__ import annotations

import os
import subprocess
import sys

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.shell import Shell
from flow_sdk.instance_settings import get_instance_settings


def _worker(session_id: str, instance: str) -> subprocess.Popen:
    env = {**os.environ, "FLOW_INSTANCE": instance}
    cmd = [sys.executable, "-c", "import time; time.sleep(30)", "--resume", session_id]
    return subprocess.Popen(cmd, env=env)


def test_sweep_matches_only_this_instances_worker():
    sid = str(mint_uuid())
    ours = _worker(sid, get_instance_settings().instance_name)
    theirs = _worker(sid, "some-other-copy")
    try:
        victims = {p.pid for p in Shell(name="t")._session_worker_procs(sid, set())}
        assert victims == {ours.pid}
    finally:
        ours.kill()
        theirs.kill()
        ours.wait()
        theirs.wait()
