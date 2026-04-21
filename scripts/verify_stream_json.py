#!/usr/bin/env python3
"""Verify that `claude --output-format stream-json` actually streams incrementally.

Spawns Claude CLI using the standard ``ClaudeCliOptions`` abstraction (with the
newly-added ``output_format`` + ``verbose`` fields), pipes stdout, and prints
each JSON event the moment it arrives — prefixed with its elapsed time since
spawn.

The prompt forces multi-step tool use (several shell ``ls`` commands in
sequence) so we get a visible distribution of events over time: if events
arrive clustered at the end, the mode is effectively buffered; if they drip
in as Claude makes tool calls, streaming is real.

Usage::

    uv run scripts/verify_stream_json.py [WORKDIR]

Exit code 0 always; the purpose is observational, not assertive.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

# Add the repo root to sys.path so we can import flow_sdk without install.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from flow_sdk.builtin.cli_workers.claude_cli import ClaudeCliOptions  # noqa: E402


PROMPT = (
    "Use the Bash tool to run these three commands in sequence and report "
    "what you observe:\n"
    "1. ls -1 flow_sdk | head -20\n"
    "2. ls -1 flow_sdk/builtin | head -20\n"
    "3. ls -1 flow_sdk/core | head -20\n"
    "After each command, briefly describe one notable file. Keep total "
    "response under 12 lines."
)


def main() -> int:
    workdir = sys.argv[1] if len(sys.argv) > 1 else str(ROOT)
    opts = ClaudeCliOptions(
        workdir=workdir,
        output_format="stream-json",
        print_mode=True,
        # verbose=True implicitly enabled by output_format="stream-json"
    )
    argv, env_from_opts = opts.to_spawn_args(instruction=PROMPT)

    # Merge env with caller's PATH/HOME so the CLI can find its binaries and creds.
    env = {**os.environ, **env_from_opts}

    # Echo the resolved command so the "standard way" is visible.
    print(f"cwd={workdir}")
    print("argv:", " ".join(repr(a) for a in argv))
    print("-" * 80, flush=True)

    t0 = time.monotonic()
    def ts() -> str:
        return f"[t+{int((time.monotonic() - t0) * 1000):>6} ms]"

    # bufsize=1 → line-buffered; each newline surfaces to us immediately.
    proc = subprocess.Popen(
        argv,
        cwd=workdir,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.DEVNULL,
        text=True,
        bufsize=1,
    )
    assert proc.stdout is not None

    event_count = 0
    type_histogram: dict[str, int] = {}
    first_event_ms: int | None = None
    last_event_ms: int | None = None

    try:
        for raw in proc.stdout:
            line = raw.rstrip("\n")
            if not line:
                continue
            event_count += 1
            elapsed_ms = int((time.monotonic() - t0) * 1000)
            if first_event_ms is None:
                first_event_ms = elapsed_ms
            last_event_ms = elapsed_ms

            try:
                event = json.loads(line)
                etype = event.get("type", "?")
                subtype = event.get("subtype")
                type_key = f"{etype}:{subtype}" if subtype else etype
                type_histogram[type_key] = type_histogram.get(type_key, 0) + 1

                # Summarise the event for readable streaming output.
                summary = _summarise(event)
                print(f"{ts()} {type_key:<28} {summary}", flush=True)
            except json.JSONDecodeError:
                # Non-JSON line (shouldn't happen in stream-json mode).
                print(f"{ts()} NON-JSON {line[:140]}", flush=True)
    finally:
        proc.wait(timeout=120)
        stderr = proc.stderr.read() if proc.stderr else ""
        total_ms = int((time.monotonic() - t0) * 1000)

    print("-" * 80)
    print(f"exit code:         {proc.returncode}")
    print(f"total events:      {event_count}")
    if first_event_ms is not None and last_event_ms is not None:
        print(f"first event at:    t+{first_event_ms} ms")
        print(f"last event at:     t+{last_event_ms} ms")
        spread = last_event_ms - first_event_ms
        print(f"spread:            {spread} ms  "
              f"({'streaming' if spread > 500 else 'burst'})")
    print(f"total time:        {total_ms} ms")
    print("event types:")
    for k, v in sorted(type_histogram.items(), key=lambda kv: -kv[1]):
        print(f"  {k:<30} {v}")
    if stderr:
        print("--- stderr ---")
        print(stderr[:2000])
    return 0


def _summarise(event: dict) -> str:
    """Produce a short single-line summary of a stream-json event."""
    etype = event.get("type")
    if etype == "system":
        return f"subtype={event.get('subtype')}"
    if etype == "assistant":
        msg = event.get("message") or {}
        blocks = msg.get("content") or []
        pieces: list[str] = []
        for b in blocks:
            btype = b.get("type")
            if btype == "text":
                pieces.append(f"text[{len(b.get('text', ''))}]")
            elif btype == "tool_use":
                pieces.append(f"tool_use({b.get('name')})")
            elif btype == "thinking":
                pieces.append(f"thinking[{len(b.get('thinking', ''))}]")
            else:
                pieces.append(str(btype))
        return " ".join(pieces)
    if etype == "user":
        msg = event.get("message") or {}
        blocks = msg.get("content") or []
        pieces = []
        for b in blocks:
            if isinstance(b, dict):
                if b.get("type") == "tool_result":
                    content = b.get("content")
                    if isinstance(content, list):
                        total = sum(len(c.get("text", "")) for c in content if isinstance(c, dict))
                    else:
                        total = len(str(content or ""))
                    pieces.append(f"tool_result[{total}]")
                else:
                    pieces.append(str(b.get("type")))
        return " ".join(pieces) if pieces else "(user msg)"
    if etype == "result":
        return f"subtype={event.get('subtype')} cost={event.get('total_cost_usd')}"
    return ""


if __name__ == "__main__":
    sys.exit(main())
