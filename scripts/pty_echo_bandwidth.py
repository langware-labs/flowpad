#!/usr/bin/env python3
"""Char-by-char PTY echo bandwidth test.

Bypasses the WebSocket / UI layer. Uses the SDK to spawn a PTY
(AgenticProcess → claude, or Shell → zsh), then for N rounds:

  t0 = now
  pty.write("a")
  wait until "a" appears in pty.output()
  record (now - t0)

This isolates raw PTY echo latency from the WS round-trip the UI uses.
If this is ~5ms and the UI feels 300ms, the WS layer is at fault. If
this is also ~300ms, the bottleneck lives in on_pty_output / write
plumbing on the server side.

Usage:
  uv run python scripts/pty_echo_bandwidth.py --mode shell --n 100
  uv run python scripts/pty_echo_bandwidth.py --mode agent --n 100
"""
from __future__ import annotations

import argparse
import asyncio
import statistics
import sys
import time


async def _start_drain(pty) -> tuple[asyncio.Queue, asyncio.Task]:
    """Drain pty.output() forever into a fresh asyncio.Queue.

    Returns (queue, task). Wrapping the async generator in a long-lived
    task means we never cancel `await q.get()` inside it — cancelling
    `wait_for(it.__anext__())` would close the generator prematurely.
    """
    out_q: asyncio.Queue = asyncio.Queue()

    async def _pump():
        async for chunk in pty.output():
            await out_q.put(chunk)

    task = asyncio.create_task(_pump())
    return out_q, task


async def _drain_until_idle(out_q: asyncio.Queue, idle_ms: int, timeout: float) -> bytes:
    """Pull chunks off the queue until silent for idle_ms, or timeout."""
    deadline = time.monotonic() + timeout
    buf = b""
    while time.monotonic() < deadline:
        try:
            chunk = await asyncio.wait_for(out_q.get(), timeout=idle_ms / 1000)
            buf += chunk
        except asyncio.TimeoutError:
            return buf
    return buf


async def _measure(pty, n: int, char: str, per_round_timeout: float) -> list[float]:
    out_q, pump = await _start_drain(pty)

    print(f"[setup] draining initial output …", flush=True)
    initial = await _drain_until_idle(out_q, idle_ms=500, timeout=15.0)
    print(f"[setup] drained {len(initial)} bytes; prompt should be idle", flush=True)

    needle = char.encode()
    latencies: list[float] = []
    misses = 0

    try:
        for i in range(n):
            t0 = time.monotonic()
            await pty.write(needle)
            # Wait for the next chunk(s) containing the char
            found = False
            while True:
                try:
                    chunk = await asyncio.wait_for(out_q.get(), timeout=per_round_timeout)
                except asyncio.TimeoutError:
                    misses += 1
                    print(f"[#{i}] TIMEOUT waiting for echo of {needle!r}", flush=True)
                    break
                if needle in chunk:
                    found = True
                    break
            if not found:
                continue
            dt_ms = (time.monotonic() - t0) * 1000
            latencies.append(dt_ms)
            if (i + 1) % 10 == 0:
                print(
                    f"  …{i + 1}/{n}  last={dt_ms:.1f}ms  median={statistics.median(latencies):.1f}ms",
                    flush=True,
                )
    finally:
        pump.cancel()
        try:
            await pump
        except (asyncio.CancelledError, Exception):
            pass

    if misses:
        print(f"[warn] {misses} rounds timed out", flush=True)
    return latencies


def _report(latencies: list[float]) -> None:
    if not latencies:
        print("no samples collected")
        return
    s = sorted(latencies)
    pct = lambda q: s[min(len(s) - 1, int(len(s) * q))]
    print()
    print("=" * 50)
    print(f" samples : {len(s)}")
    print(f" min     : {min(s):.2f} ms")
    print(f" median  : {statistics.median(s):.2f} ms")
    print(f" mean    : {statistics.mean(s):.2f} ms")
    print(f" p90     : {pct(0.90):.2f} ms")
    print(f" p99     : {pct(0.99):.2f} ms")
    print(f" max     : {max(s):.2f} ms")
    if len(s) > 1:
        print(f" stdev   : {statistics.stdev(s):.2f} ms")
    print("=" * 50)
    # 5ms-bin histogram
    buckets: dict[int, int] = {}
    for x in s:
        b = int(x // 5) * 5
        buckets[b] = buckets.get(b, 0) + 1
    print(" histogram (5ms bins):")
    for b in sorted(buckets):
        bar = "#" * min(50, buckets[b])
        print(f"  {b:>4}-{b + 4:<4} ms  {bar} {buckets[b]}")


async def run_shell(n: int, char: str) -> None:
    from flow_sdk.builtin.shell import Shell
    print("[mode] shell (zsh via SDK)", flush=True)
    shell = await Shell.open(workdir="/tmp")
    pty = shell.compute_node.get_pty(shell.id)
    assert pty is not None, "no PTY after Shell.open()"
    try:
        latencies = await _measure(pty, n, char, per_round_timeout=2.0)
        _report(latencies)
    finally:
        try:
            await pty.kill()
        except Exception as e:
            print(f"[cleanup] pty.kill failed: {e}", flush=True)


async def run_agent(n: int, char: str) -> None:
    from flow_sdk.builtin.agentic_process import AgenticProcess
    print("[mode] agent (claude via SDK AgenticProcess)", flush=True)
    proc = AgenticProcess(workdir="/tmp")
    await proc.save()
    print(f"[setup] starting claude PTY (this can take a few seconds)…", flush=True)
    await proc.start_pty()
    shell = await proc.shell()
    pty = shell.compute_node.get_pty(shell.id)
    assert pty is not None, "no PTY after AgenticProcess.start_pty()"
    try:
        latencies = await _measure(pty, n, char, per_round_timeout=3.0)
        _report(latencies)
    finally:
        try:
            await proc.close()
        except Exception as e:
            print(f"[cleanup] proc.close failed: {e}", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["shell", "agent"], default="shell")
    ap.add_argument("--n", type=int, default=100)
    ap.add_argument("--char", default="a", help="char to type each round (default 'a')")
    args = ap.parse_args()

    if args.mode == "shell":
        asyncio.run(run_shell(args.n, args.char))
    else:
        asyncio.run(run_agent(args.n, args.char))
    return 0


if __name__ == "__main__":
    sys.exit(main())
