"""Minimum headless turn runner for stress-matrix cells.

Spawns ``ClaudeCLIStreamWorker.execute()`` against a trivial prompt, drains
the FlowData stream, and writes a sentinel JSON into the workdir so the host
test can assert on what actually happened (vs. just exit code).

Exit codes:
  0 — turn produced at least one FlowData frame and Claude returned a session_id.
  1 — turn produced no FlowData frames or no session_id (claude never started).
  2 — runner crashed (uncaught exception). stderr will contain the traceback.

Usage:
  python /opt/runner_entrypoint.py <workdir> <prompt>
"""

from __future__ import annotations

import asyncio
import json
import sys
import traceback
from pathlib import Path


SENTINEL_NAME = "_runner_complete.json"


async def _drive(prompt: str, workdir: str) -> dict:
    # Imported here so a crash during import surfaces as exit code 2 with
    # a clear traceback, not a silent module-load failure.
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
        AgenticContext,
    )
    from flow_sdk.builtin.agentic_process.cli_drivers.claude.stream_worker import (
        ClaudeCLIStreamWorker,
    )

    ctx = AgenticContext(workdir=workdir)
    worker = ClaudeCLIStreamWorker()

    n_frames = 0
    last_text = ""
    saw_error_frame = False

    async for fd in worker.execute(prompt=prompt, context=ctx):
        n_frames += 1
        attrs = getattr(fd, "attributes", {}) or {}
        if str(attrs.get("element-type", "")).lower() == "error":
            saw_error_frame = True
        value = getattr(fd, "flow_value", None)
        if value:
            last_text = str(value)[:200]

    return {
        "n_frames": n_frames,
        "session_id": worker.get_session_id(),
        "last_text": last_text,
        "saw_error_frame": saw_error_frame,
    }


def main() -> int:
    if len(sys.argv) < 3:
        print(
            "RUNNER_BLOCKED: usage: runner_entrypoint.py <workdir> <prompt>",
            file=sys.stderr,
        )
        return 64

    workdir = sys.argv[1]
    prompt = sys.argv[2]
    sentinel_path = Path(workdir) / SENTINEL_NAME

    try:
        outcome = asyncio.run(_drive(prompt, workdir))
    except Exception:
        traceback.print_exc()
        try:
            sentinel_path.write_text(
                json.dumps({"error": "runner_exception"}),
            )
        except Exception:
            pass
        return 2

    sentinel_path.write_text(json.dumps(outcome))

    if outcome["n_frames"] == 0 or not outcome["session_id"]:
        print(
            f"RUNNER_BLOCKED: no_session (frames={outcome['n_frames']}, "
            f"sid={outcome['session_id']})",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
