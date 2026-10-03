"""The env-probe child imports nothing of Flowpad — the reason it is a child at all.

It is spawned on every capability sweep and runs under a kill cap
(``PROBE_TIMEOUT_SECONDS``). It used to be started as ``python -m
flow_sdk.core.capabilities.env_probe``, and ``-m`` imports the parent packages
first: ``flow_sdk.core`` and ``flow_sdk.core.capabilities`` pull in the entity
model and the registry. On Windows that import alone outran the cap, so every
sweep — the boot sweep, each status refresh, the setup wizard's install check —
waited the full five seconds and fell back to the process PATH.
"""

from __future__ import annotations

import asyncio
import subprocess
import sys

import pytest

from flow_sdk.core.capabilities import discovery

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


def test_the_child_is_started_by_file_path_and_imports_no_flowpad_module(monkeypatch):
    argv: list[str] = []

    async def capture(*args, **_kwargs):
        argv.extend(args)
        raise RuntimeError("captured")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", capture)
    asyncio.run(discovery._run_env_probe(["sh"]))

    assert "-m" not in argv, "`-m` imports the parent packages, which is the whole cost"
    script = argv[1]
    imported = subprocess.run(
        [sys.executable, "-X", "importtime", script, "sh"], capture_output=True, text=True, timeout=20
    ).stderr
    flowpad = [line for line in imported.splitlines() if "flow_sdk" in line]
    assert not flowpad, f"the probe child imported Flowpad modules: {flowpad[:3]}"
