#!/usr/bin/env python3
"""Proof-of-concept: spawn Claude CLI directly as a PTY process and inject an instruction.

Tests the core idea behind the direct PTY spawn plan — no zsh intermediary.

Usage:
    python scripts/test_direct_pty_spawn.py

What it proves:
1. Claude CLI can be spawned directly via PtyProcess.spawn() (no shell)
2. The PTY PID IS Claude's PID — no child-process hunting needed
3. Instructions can be injected via PTY stdin after Claude is ready
4. Claude writes a JSONL transcript that is discoverable
5. Output can be read in real-time from the PTY fd
"""

import os
import select
import signal
import sys
import time
import uuid
from pathlib import Path

import ptyprocess

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SESSION_ID = str(uuid.uuid4())
WORKDIR = Path("/tmp") / f"flowpad_pty_test_{SESSION_ID[:8]}"
WORKDIR.mkdir(parents=True, exist_ok=True)

INSTRUCTION = "Create a file named hello.txt with the content 'Hello from direct PTY spawn'."

TIMEOUT_READY = 15.0   # seconds to wait for Claude to show its initial prompt
TIMEOUT_DONE  = 30.0   # seconds to wait for Claude to finish the task
IDLE_THRESHOLD = 1.5   # seconds of output silence → consider Claude ready for input

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def strip_ansi(data: bytes) -> str:
    """Crude ANSI escape stripper for readable output."""
    import re
    text = data.decode("utf-8", errors="replace")
    return re.sub(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][0-9A-Za-z]|\x1b[=>]|\r", "", text)


def read_until_idle(fd: int, idle_seconds: float, deadline: float) -> bytes:
    """Read from fd until output has been idle for idle_seconds or deadline passes."""
    buf = b""
    last_read = time.time()
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                chunk = os.read(fd, 4096)
                buf += chunk
                last_read = time.time()
            except OSError:
                break
        elif time.time() - last_read >= idle_seconds:
            break
    return buf


def find_jsonl(session_id: str) -> Path | None:
    """Scan ~/.claude/projects/ for the JSONL transcript."""
    claude_projects = Path.home() / ".claude" / "projects"
    for jsonl in claude_projects.rglob(f"{session_id}.jsonl"):
        return jsonl
    return None


def tail_jsonl_types(jsonl_path: Path) -> list[str]:
    """Return the last 5 entry types from the JSONL transcript."""
    import json
    types = []
    try:
        for line in jsonl_path.read_text().splitlines():
            line = line.strip()
            if line:
                try:
                    types.append(json.loads(line).get("type", "?"))
                except Exception:
                    pass
    except Exception:
        pass
    return types[-5:]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print(f"\n{'='*60}")
    print(f"Direct PTY Spawn Test")
    print(f"{'='*60}")
    print(f"session_id : {SESSION_ID}")
    print(f"workdir    : {WORKDIR}")
    print(f"instruction: {INSTRUCTION}")
    print(f"{'='*60}\n")

    # ------------------------------------------------------------------
    # Build argv — same logic as planned to_spawn_args()
    # ------------------------------------------------------------------
    import shlex

    argv = [
        "claude",
        "--dangerously-skip-permissions",
        "--debug",
        "--session-id", SESSION_ID,
        "--", INSTRUCTION,
    ]

    # Env: strip CLAUDECODE* nesting guards, keep everything else
    env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDECODE")}
    env["CLAUDE_PROJECT_DIR"] = str(WORKDIR)
    env["TERM"] = "xterm-256color"

    print(f"[spawn] argv = {argv}")
    print(f"[spawn] cwd  = {WORKDIR}")
    print()

    # ------------------------------------------------------------------
    # Spawn Claude directly as the PTY process
    # ------------------------------------------------------------------
    t_spawn = time.time()
    proc = ptyprocess.PtyProcess.spawn(
        argv,
        cwd=str(WORKDIR),
        dimensions=(24, 200),
        env=env,
    )
    fd = proc.fileno()

    print(f"[✓] Claude spawned")
    print(f"    PID = {proc.pid}  ← this IS Claude's PID, no child-process hunting")
    print(f"    PTY fd = {fd}")
    print()

    # ------------------------------------------------------------------
    # Verify PID is Claude (not a shell)
    # ------------------------------------------------------------------
    import psutil
    try:
        p = psutil.Process(proc.pid)
        print(f"[verify] Process name : {p.name()}")
        print(f"[verify] Process exe  : {p.exe()}")
        print(f"[verify] Parent       : {p.parent().name() if p.parent() else 'none'}")
        # Crucially: no shell parent
        assert "claude" in p.name().lower() or "claude" in p.exe().lower(), \
            f"Expected claude process, got: {p.name()}"
        print(f"[✓] Confirmed: PTY pid {proc.pid} IS claude, not a shell\n")
    except psutil.NoSuchProcess:
        print(f"[!] Process {proc.pid} already exited (very fast start?)\n")

    # ------------------------------------------------------------------
    # Read Claude's output until done
    # ------------------------------------------------------------------
    print(f"[reading] Collecting PTY output (timeout={TIMEOUT_DONE}s)...")
    deadline = time.time() + TIMEOUT_DONE
    all_output = b""
    last_activity = time.time()

    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                chunk = os.read(fd, 4096)
                all_output += chunk
                last_activity = time.time()
                # Print raw output lines as they arrive
                sys.stdout.write(strip_ansi(chunk))
                sys.stdout.flush()
            except OSError:
                print("\n[PTY closed by Claude]")
                break

        # Check if Claude is done via JSONL transcript
        jsonl = find_jsonl(SESSION_ID)
        if jsonl:
            tail = tail_jsonl_types(jsonl)
            if "last-prompt" in tail:
                print(f"\n[✓] Detected 'last-prompt' in JSONL — Claude finished")
                break

        if not proc.isalive():
            print(f"\n[Claude process exited]")
            break

    elapsed = time.time() - t_spawn
    print(f"\n{'='*60}")
    print(f"Results after {elapsed:.1f}s")
    print(f"{'='*60}")

    # ------------------------------------------------------------------
    # Check output file
    # ------------------------------------------------------------------
    hello = WORKDIR / "hello.txt"
    if hello.exists():
        print(f"[✓] hello.txt created: {hello.read_text()!r}")
    else:
        files = list(WORKDIR.iterdir())
        print(f"[✗] hello.txt NOT found. Files in workdir: {files}")

    # ------------------------------------------------------------------
    # Check JSONL transcript
    # ------------------------------------------------------------------
    jsonl = find_jsonl(SESSION_ID)
    if jsonl:
        tail = tail_jsonl_types(jsonl)
        print(f"[✓] JSONL transcript found: {jsonl}")
        print(f"    Last 5 entry types: {tail}")
    else:
        print(f"[✗] JSONL transcript NOT found for session {SESSION_ID}")

    # ------------------------------------------------------------------
    # PID still alive?
    # ------------------------------------------------------------------
    import psutil
    pid_alive = psutil.pid_exists(proc.pid)
    print(f"[info] Claude PID {proc.pid} alive: {pid_alive}")

    # ------------------------------------------------------------------
    # Cleanup
    # ------------------------------------------------------------------
    if proc.isalive():
        try:
            os.kill(proc.pid, signal.SIGTERM)
            time.sleep(0.5)
            if proc.isalive():
                os.kill(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    try:
        proc.close()
    except Exception:
        pass

    print(f"\n[done] Workdir: {WORKDIR}")
    print(f"[done] Session: {SESSION_ID}")


if __name__ == "__main__":
    main()
