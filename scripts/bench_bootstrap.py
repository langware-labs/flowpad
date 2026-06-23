#!/usr/bin/env python3
"""bench_bootstrap.py — measure COLD bootstrap time on a fresh instance.

A "cold" bootstrap is the very first ``GET /api/v1/graph/bootstrap`` against a
brand-new, empty ``~/.flow/instances/<name>/`` data dir: empty SQLite DB, no
``@local`` entities yet, bootstrap cache empty. This is the slow path the UI
hits on first launch, and the one the 500ms budget (``_t.done(0.5)`` in
``bootstrap.py``) is about.

What it does:
  1. Wipe ``~/.flow/instances/<name>/`` so the run is genuinely cold.
  2. Start ONLY the backend (isolated via FLOW_INSTANCE, skip dotenv/lock,
     no uvicorn reloader). The frontend (vite) is irrelevant to bootstrap
     timing, so we don't start it.
  3. Wait for the TCP port to LISTEN — WITHOUT calling /bootstrap, so the
     first call we make is the cold one.
  4. Time the first /bootstrap (cold), then a second call (warm/cached).
  5. Surface the per-step TimeIt breakdown the handler logs on >500ms.
  6. Tear the backend down.

Usage:
    uv run scripts/bench_bootstrap.py [--name bench-cold] [--port 6007] [--keep]
"""

from __future__ import annotations

import argparse
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
FLOW_HOME = Path(os.environ.get("FLOW_HOME", Path.home() / ".flow"))


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def _pick_port(preferred: int) -> int:
    for p in range(preferred, preferred + 100):
        if p in (6000,):  # ERR_UNSAFE_PORT
            continue
        if _port_free(p):
            return p
    raise SystemExit("no free backend port found")


def _wait_for_listen(port: int, timeout: float = 120.0) -> None:
    """Block until something is LISTENing on the port (does NOT hit /bootstrap)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.25)
    raise SystemExit(f"backend did not start LISTENing on :{port} within {timeout}s")


def _timed_get(url: str, timeout: float = 60.0) -> tuple[float, int]:
    t0 = time.perf_counter()
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        resp.read()
        status = resp.status
    return (time.perf_counter() - t0) * 1000, status


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="bench-cold")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--keep", action="store_true", help="leave the instance dir + backend running")
    args = ap.parse_args()

    name = args.name
    port = args.port or _pick_port(6007)
    instance_dir = FLOW_HOME / "instances" / name
    log_path = instance_dir.parent / f"{name}-bench.log"

    # 1. wipe for a cold run
    if instance_dir.exists():
        shutil.rmtree(instance_dir)
    instance_dir.mkdir(parents=True, exist_ok=True)

    env = {
        **os.environ,
        "FLOW_INSTANCE": name,
        "LOCAL_SERVER_PORT": str(port),
        "FLOWPAD_SKIP_DOTENV": "true",   # don't let .env.local clobber our port
        "MINIHUB_RELOAD": "False",       # single process, no reloader fork
    }
    # NOTE: we deliberately do NOT set FLOWPAD_SKIP_LOCK. The singleton lock is
    # per-instance (instances/<name>/server.lock), so a fresh unique name has no
    # contention — and FLOWPAD_SKIP_LOCK=true makes _on_server_startup bail early,
    # which would skip the background capability-discovery sweep + system-content
    # index that the (decoupled) cold bootstrap relies on to self-heal. Running
    # without it is the faithful production startup path.

    print(f"[bench] instance : {name}")
    print(f"[bench] backend  : http://localhost:{port}")
    print(f"[bench] data dir : {instance_dir}  (wiped, cold)")
    print(f"[bench] log      : {log_path}")

    logf = open(log_path, "w")
    proc = subprocess.Popen(
        ["uv", "run", "-m", "flow_sdk.server.run"],
        cwd=str(REPO_ROOT),
        env=env,
        stdout=logf,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )

    cold_ms = warm_ms = None
    try:
        print("[bench] waiting for backend to LISTEN (not calling /bootstrap yet) ...")
        _wait_for_listen(port)
        # tiny settle so the ASGI app is actually accepting, not just bound
        time.sleep(0.2)

        url = f"http://localhost:{port}/api/v1/graph/bootstrap"
        cold_ms, status = _timed_get(url)
        print(f"\n[bench] COLD  bootstrap: {cold_ms:8.1f} ms  (HTTP {status})")

        warm_ms, status = _timed_get(url)
        print(f"[bench] WARM  bootstrap: {warm_ms:8.1f} ms  (HTTP {status}, cached)")

        budget = 500.0
        verdict = "PASS ✅" if cold_ms < budget else "FAIL ❌"
        print(f"\n[bench] cold vs {budget:.0f}ms budget: {verdict}")
    finally:
        logf.flush()
        # surface the handler's own per-step breakdown (logged when >500ms)
        try:
            log_text = log_path.read_text(errors="replace")
        except Exception:
            log_text = ""
        if "slowness detected" in log_text:
            idx = log_text.index("slowness detected")
            start = log_text.rfind("\n", 0, idx - 80)
            print("\n[bench] ---- handler per-step breakdown (from backend log) ----")
            print(log_text[max(start, 0): idx + 1200].rstrip())

        if not args.keep:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            except (OSError, ProcessLookupError):
                proc.terminate()
            try:
                proc.wait(timeout=10)
            except Exception:
                proc.kill()
            shutil.rmtree(instance_dir, ignore_errors=True)
            print("\n[bench] backend stopped, instance dir removed")
        else:
            print(f"\n[bench] left running (pid {proc.pid}); kill with: kill {proc.pid}")

    return 0 if (cold_ms is not None and cold_ms < 500) else 1


if __name__ == "__main__":
    sys.exit(main())
