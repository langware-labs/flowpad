"""Assert a spawn on a machine with NO harness fails immediately and says so.

Runs as the container entrypoint (`tests/isolation/Dockerfile`, a python:3.10-slim
with no node and no vendor CLI), and standalone against a stripped PATH. Both
give the same thing the unit tests cannot: a REAL process, resolving for real,
where nothing is installed.

What is actually being defended: before lazy resolution, a spawn with no
discovery sweep did not fail cleanly — the worker died before writing a
transcript and the caller polled to its full deadline, then reported "transcript
file did not appear within timeout". The bug was never "not installed"; it was
that you could not tell. So the assertions are as much about SPEED and WORDING as
about the exception.

Prints `ISOLATION_PASS` / `ISOLATION_FAIL: …`; exit code matches.
"""
from __future__ import annotations

import asyncio
import shutil
import sys
import time

BUDGET_S = 1.0  # a resolution failure is a PATH scan; anything near a second is a sweep


def _fail(message: str) -> None:
    print(f"ISOLATION_FAIL: {message}")
    sys.exit(1)


async def main() -> None:
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
        WorkerSpawnError,
        build_worker_spawn_env,
    )
    from flow_sdk.core.capabilities import discovery as discovery_mod
    from flow_sdk.flowpad_types.vendors import VENDORS

    # 0. The premise. If a CLI IS reachable here the rest proves nothing.
    for vendor in VENDORS:
        found = shutil.which(vendor.key)
        if found:
            _fail(f"{vendor.key} is on PATH at {found} — this is not an empty machine")

    # A sweep here would be a bug, not a slow path: make it fatal rather than slow.
    async def _swept(*_a, **_k):
        _fail("a discovery sweep ran on the spawn path")

    discovery_mod._run_env_probe = _swept
    discovery_mod._run_discovery_inner = _swept

    # 1. The spawn seam every path funnels into — PTY, headless and UI chat all
    #    reach build_worker_spawn_env through worker_bin_folder.
    started = time.monotonic()
    try:
        build_worker_spawn_env(VENDORS[0].worker_type, {})
    except WorkerSpawnError as exc:
        elapsed = time.monotonic() - started
        message = str(exc)
    else:
        _fail("build_worker_spawn_env did not raise with no harness installed")

    if "no harness is installed" not in message:
        _fail(f"wrong message for an empty machine: {message!r}")
    for vendor in VENDORS:
        if vendor.key not in message:
            _fail(f"message does not say {vendor.key} was looked for: {message!r}")
    if elapsed > BUDGET_S:
        _fail(f"took {elapsed:.2f}s to fail — a resolution miss must be immediate")

    # 2. The query facade agrees, and is equally immediate.
    started = time.monotonic()
    for vendor in VENDORS:
        if await AgenticProcess.is_installed(vendor.worker_type):
            _fail(f"is_installed({vendor.key}) is True on an empty machine")
    queried = time.monotonic() - started
    if queried > BUDGET_S:
        _fail(f"is_installed took {queried:.2f}s across {len(VENDORS)} vendors")

    print(f"  raise: {elapsed * 1000:.1f} ms   is_installed x{len(VENDORS)}: {queried * 1000:.1f} ms")
    print(f"  message: {message}")
    print("ISOLATION_PASS")


if __name__ == "__main__":
    asyncio.run(main())
