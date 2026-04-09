#!/usr/bin/env python3
"""Interactive PTY spawn test — no instruction at startup, inject via stdin.

Flow:
  1. Spawn Claude directly (no initial instruction)
  2. Validate ready: PTY output idle (no JSONL yet — Claude hasn't processed anything)
  3. Inject: "create hello.txt with content 'hello world'"
  4. Wait for COMPLETE via tail_status()
  5. Validate hello.txt exists
  6. Inject: "delete the hello.txt file you just created"
  7. Wait for COMPLETE via tail_status()
  8. Validate hello.txt deleted
  9. Final ready check via tail_status()

Usage:
    python scripts/test_direct_pty_interactive.py
"""

from __future__ import annotations

import json
import os
import signal
import sys
import threading
import time
import uuid
from enum import Enum
from pathlib import Path

import psutil
import ptyprocess

# ---------------------------------------------------------------------------
# _tail_status — copied verbatim from flow_sdk/fs_records/agent_status.py
# (with the permission-mode / file-history-snapshot ignore fix applied)
# ---------------------------------------------------------------------------

class Status(str, Enum):
    INIT         = "init"
    EMPTY        = "empty"
    IDLE         = "idle"
    COMPLETE     = "complete"
    ERROR        = "error"
    INTERRUPTED  = "interrupted"
    INACTIVE     = "inactive"
    WAITING      = "waiting"
    THINKING     = "thinking"
    TOOL_CALL    = "tool_call"
    TOOL_RUNNING = "tool_running"
    RUNNING      = "running"

_TAIL_BYTES    = 4096
_ACTIVE_SECS   = 300
_IGNORED_TYPES = frozenset({"permission-mode", "file-history-snapshot"})
_READY_STATUSES = frozenset({Status.COMPLETE, Status.INTERRUPTED, Status.EMPTY})
_BUSY_STATUSES  = frozenset({Status.WAITING, Status.THINKING, Status.TOOL_CALL,
                              Status.TOOL_RUNNING, Status.RUNNING})


def _last_user_text(chunk: str) -> str:
    for line in reversed(chunk.splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except Exception:
            continue
        if entry.get("type") == "user":
            msg = entry.get("message", {})
            content = msg.get("content", "") if isinstance(msg, dict) else str(msg)
            if isinstance(content, list):
                return " ".join(c.get("text", "") for c in content if c.get("type") == "text")
            return str(content)
    return ""


def tail_status(path: str | Path) -> Status:
    """Derive Status from the last 4 KB of a JSONL transcript.
    Copied verbatim from flow_sdk/fs_records/agent_status.py (_tail_status).
    """
    p = Path(path)
    try:
        stat = p.stat()
    except OSError:
        return Status.INIT

    is_active = (time.time() - stat.st_mtime) <= _ACTIVE_SECS

    try:
        sz = stat.st_size
        with open(p, "rb") as f:
            if sz > _TAIL_BYTES:
                f.seek(sz - _TAIL_BYTES)
            chunk = f.read().decode("utf-8", errors="replace")
    except OSError:
        return Status.INIT

    last_type: str | None = None
    last_stop_reason: str | None = None
    for line in reversed(chunk.splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except Exception:
            continue
        t = entry.get("type", "")
        if t in _IGNORED_TYPES:
            continue
        if last_type is None:
            last_type = t
        if t == "assistant" and last_stop_reason is None:
            last_stop_reason = entry.get("message", {}).get("stop_reason")
        if last_type and last_stop_reason is not None:
            break

    if last_type == "last-prompt":
        return Status.COMPLETE
    if last_type == "user" and "interrupted" in _last_user_text(chunk).lower():
        return Status.INTERRUPTED
    if last_stop_reason == "end_turn":
        return Status.COMPLETE
    if last_stop_reason == "stop_sequence":
        return Status.ERROR
    if not is_active:
        return Status.INACTIVE
    if last_type is None:
        return Status.EMPTY

    if last_type == "assistant" and last_stop_reason is None:
        return Status.THINKING
    if last_type == "assistant" and last_stop_reason == "tool_use":
        return Status.TOOL_CALL
    if last_type == "progress":
        return Status.TOOL_RUNNING
    if last_type == "user":
        return Status.WAITING

    return Status.RUNNING


# ---------------------------------------------------------------------------
# PTY drain thread — keeps reading output so Claude never blocks on a full buffer
# ---------------------------------------------------------------------------

class PtyDrainer:
    """Background thread that continuously reads PTY output.

    Keeps a rolling buffer of the last N bytes for inspection.
    Tracks last-output timestamp so callers can detect idle.
    """
    BUFFER_SIZE = 64 * 1024

    def __init__(self, proc: ptyprocess.PtyProcess):
        self._proc = proc
        self._fd = proc.fileno()
        self._buf = bytearray()
        self._lock = threading.Lock()
        self._last_output = time.time()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self):
        import select
        while not self._stop.is_set():
            try:
                r, _, _ = select.select([self._fd], [], [], 0.05)
                if r:
                    chunk = os.read(self._fd, 4096)
                    with self._lock:
                        self._buf.extend(chunk)
                        if len(self._buf) > self.BUFFER_SIZE:
                            del self._buf[:len(self._buf) - self.BUFFER_SIZE]
                        self._last_output = time.time()
            except OSError:
                break

    def idle_since(self) -> float:
        """Seconds since last byte of output."""
        with self._lock:
            return time.time() - self._last_output

    def stop(self):
        self._stop.set()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

SESSION_ID = str(uuid.uuid4())
WORKDIR = Path("/tmp") / f"pty_interactive_{SESSION_ID[:8]}"
WORKDIR.mkdir(parents=True, exist_ok=True)

TIMEOUT  = 90.0   # per-step timeout
IDLE_SEC = 2.0    # seconds of PTY silence → Claude at prompt
POLL     = 0.2    # polling interval


def find_jsonl() -> Path | None:
    for jsonl in (Path.home() / ".claude" / "projects").rglob(f"{SESSION_ID}.jsonl"):
        return jsonl
    return None


def wait_for_jsonl(timeout: float = TIMEOUT) -> Path:
    deadline = time.time() + timeout
    while time.time() < deadline:
        p = find_jsonl()
        if p:
            return p
        time.sleep(POLL)
    raise TimeoutError(f"JSONL did not appear within {timeout}s")


def wait_for_pty_idle(drainer: PtyDrainer, idle_seconds: float = IDLE_SEC,
                      timeout: float = TIMEOUT) -> None:
    """Block until PTY output has been silent for idle_seconds."""
    deadline = time.time() + timeout
    # First wait for some output to arrive (Claude is rendering its UI)
    start = time.time()
    while time.time() < deadline:
        if drainer.idle_since() < (time.time() - start):
            break  # output has started
        time.sleep(0.1)
    # Then wait for it to go idle
    while time.time() < deadline:
        if drainer.idle_since() >= idle_seconds:
            return
        time.sleep(0.1)
    raise TimeoutError(f"PTY did not go idle within {timeout}s")


def wait_for_ready(jsonl: Path, timeout: float = TIMEOUT, label: str = "",
                   wait_for_busy: bool = False) -> Status:
    """Poll tail_status until Claude reaches a ready (non-busy) state.

    If wait_for_busy=True, first waits for Claude to leave the ready state
    (i.e., start processing the new instruction), then waits for COMPLETE.
    """
    deadline = time.time() + timeout
    last_status = None

    if wait_for_busy:
        # Phase 1: wait until Claude leaves ready state
        while time.time() < deadline:
            s = tail_status(jsonl)
            if s != last_status:
                print(f"    [{label}] tail_status → {s.value}")
                last_status = s
            if s not in _READY_STATUSES:
                break
            time.sleep(POLL)
        else:
            raise TimeoutError(f"Claude never left ready state within {timeout}s")

    # Phase 2: wait for ready
    while time.time() < deadline:
        s = tail_status(jsonl)
        if s != last_status:
            print(f"    [{label}] tail_status → {s.value}")
            last_status = s
        if s in _READY_STATUSES:
            return s
        if s in (Status.ERROR, Status.INACTIVE):
            raise RuntimeError(f"Claude hit terminal error state: {s.value}")
        time.sleep(POLL)
    raise TimeoutError(f"Claude did not reach ready within {timeout}s. Last: {last_status}")


def inject(proc: ptyprocess.PtyProcess, text: str) -> None:
    """Write text + Enter to Claude's PTY stdin."""
    proc.write((text + "\r").encode())
    print(f"    [inject] {text!r}")


def ok(msg: str) -> None:   print(f"  ✓ {msg}")
def fail(msg: str) -> None: print(f"  ✗ {msg}"); sys.exit(1)
def step(n: int, title: str) -> None:
    print(f"\n{'─'*60}\nStep {n}: {title}\n{'─'*60}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print(f"\n{'='*60}")
    print(f"Interactive Direct PTY Spawn Test")
    print(f"{'='*60}")
    print(f"session : {SESSION_ID}")
    print(f"workdir : {WORKDIR}")

    # ── Step 1: Spawn Claude — no instruction ──────────────────────────
    step(1, "Spawn Claude (no instruction)")

    argv = [
        "claude",
        "--dangerously-skip-permissions",
        "--debug",
        "--session-id", SESSION_ID,
    ]
    env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDECODE")}
    env["CLAUDE_PROJECT_DIR"] = str(WORKDIR)
    env["TERM"] = "xterm-256color"

    proc = ptyprocess.PtyProcess.spawn(argv, cwd=str(WORKDIR), dimensions=(24, 200), env=env)
    drainer = PtyDrainer(proc)

    ok(f"Spawned — PID={proc.pid} (Claude directly, no shell)")
    p = psutil.Process(proc.pid)
    ok(f"Process: {p.name()} | exe: {p.exe()}")
    assert "claude" in p.exe().lower(), f"Expected claude exe, got: {p.exe()}"

    # ── Step 2: Validate ready — PTY idle, no JSONL yet ───────────────
    step(2, "Validate ready (PTY idle — no JSONL expected)")

    print("  Waiting for PTY output to go idle...")
    wait_for_pty_idle(drainer, idle_seconds=IDLE_SEC)
    ok(f"PTY output idle for {IDLE_SEC}s — Claude at prompt")

    # Claude writes NO JSONL until it receives its first instruction
    assert find_jsonl() is None, "JSONL should not exist before first instruction"
    ok("No JSONL yet — confirmed: Claude hasn't processed any instruction")

    # ── Step 3: Inject create-file instruction ─────────────────────────
    step(3, "Inject: create hello.txt")
    inject(proc, "Create a file named hello.txt with the content 'hello world'")

    # ── Step 4: Wait for COMPLETE via tail_status ──────────────────────
    step(4, "Wait for COMPLETE via tail_status")

    print("  Waiting for JSONL to appear...")
    jsonl = wait_for_jsonl()
    ok(f"JSONL found: {jsonl}")

    status = wait_for_ready(jsonl, label="after-create")
    ok(f"Claude ready — tail_status={status.value}")

    # ── Step 5: Validate hello.txt created ────────────────────────────
    step(5, "Validate hello.txt was created")

    hello = WORKDIR / "hello.txt"
    if hello.exists():
        ok(f"hello.txt exists — content: {hello.read_text().strip()!r}")
    else:
        fail(f"hello.txt NOT found in {WORKDIR}")

    # ── Step 6: Inject delete instruction ─────────────────────────────
    step(6, "Inject: delete hello.txt")
    inject(proc, "Delete the hello.txt file you just created")

    # ── Step 7: Wait for COMPLETE via tail_status ──────────────────────
    step(7, "Wait for COMPLETE via tail_status")

    status = wait_for_ready(jsonl, label="after-delete", wait_for_busy=True)
    ok(f"Claude ready — tail_status={status.value}")

    # ── Step 8: Validate hello.txt deleted ────────────────────────────
    step(8, "Validate hello.txt was deleted")

    if not hello.exists():
        ok("hello.txt deleted successfully")
    else:
        fail(f"hello.txt still exists after delete instruction")

    # ── Step 9: Final ready check via tail_status ──────────────────────
    step(9, "Final ready check")

    final_status = tail_status(jsonl)
    ok(f"Final tail_status: {final_status.value}")
    assert final_status in _READY_STATUSES, \
        f"Expected ready status, got: {final_status.value}"

    # Summary
    print(f"\n{'='*60}")
    print(f"ALL STEPS PASSED")
    print(f"session : {SESSION_ID}")
    print(f"jsonl   : {jsonl}")
    print(f"workdir : {WORKDIR}")
    print(f"{'='*60}\n")

    drainer.stop()
    try:
        os.kill(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        proc.close()
    except Exception:
        pass


if __name__ == "__main__":
    main()
