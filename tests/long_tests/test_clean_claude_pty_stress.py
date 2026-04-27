"""Stress test: launch Claude 50 times, validate a clean PTY each time.

Approach
--------
1. One-time *reference capture*: spawn ``claude --dangerously-skip-permissions``
   directly via ptyprocess in an isolated environment (no Flowpad env vars),
   render the PTY bytes to a 24×80 screen buffer, then extract structural
   *invariants* from that rendered screen — things that must appear on every
   clean Claude Code start regardless of user identity or working directory:

       • A full-width horizontal separator (≥60 '─' chars)
       • The ``❯`` input-prompt glyph on its own line with *nothing* after it
       • The ``⏵⏵`` bypass-permissions indicator

2. Each of the 50 stress iterations starts a fresh ``AgenticProcess``, waits
   for PTY output to settle, renders the PTY from the Claude Code section
   (everything after the first ``MODE ON ?2004`` / ``\\x1b[?2004h`` from
   Claude Code), and asserts the same invariants are satisfied *and* that the
   prompt line is empty (no leaked startup command).

Fails on any iteration that contains a leaked command in the Claude Code
section.  Zero knowledge of '200~', '201~', or any Flowpad-specific strings.
"""

import asyncio
import os
import re
import select
import time

import ptyprocess
import pytest

from tests.test_settings import test_service_config

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.compute.providers.desktop.pty_replay_buffer import replay_buffer
from flow_sdk.config import FLOWPAD_TEMP_DIR

# ── Constants ─────────────────────────────────────────────────────────────────

ITERATIONS = 50
SETTLE_SLEEP = 1.5  # seconds to wait after process.start() before reading PTY

# Minimum run of '─' chars that counts as Claude Code's separator line.
MIN_SEPARATOR_LEN = 60

# ── VT100 screen renderer ──────────────────────────────────────────────────────

def render_pty_screen(raw: bytes, cols: int = 80, rows: int = 24) -> list[str]:
    """Render PTY bytes onto a cols×rows character grid.

    Handles the CSI sequences Claude Code actually uses:
    cursor positioning (H/f/A/B/C/D), erase (J/K), OSC title escapes.
    Returns a list of *rows* stripped rows (trailing spaces removed).
    """
    screen = [[" "] * cols for _ in range(rows)]
    row = col = 0

    data = raw.decode("utf-8", errors="replace")
    i = 0
    while i < len(data):
        c = data[i]

        if c == "\x1b":
            nxt = data[i + 1] if i + 1 < len(data) else ""

            if nxt == "[":
                # CSI  ─  scan to final byte (skip intermediate bytes: ? > < = !)
                j = i + 2
                while j < len(data) and (data[j].isdigit() or data[j] in ";?><!="):
                    j += 1
                if j < len(data):
                    cmd = data[j]
                    raw_params = re.sub(r"[?><!=]", "", data[i + 2 : j])
                    parts = raw_params.split(";")
                    params = []
                    for p in parts:
                        try:
                            params.append(int(p))
                        except ValueError:
                            params.append(0)
                    if not params:
                        params = [0]

                    if cmd in ("H", "f"):
                        row = max(0, min(rows - 1, (params[0] - 1) if params[0] else 0))
                        col = max(0, min(cols - 1, (params[1] - 1) if len(params) > 1 and params[1] else 0))
                    elif cmd == "A":
                        row = max(0, row - (params[0] or 1))
                    elif cmd == "B":
                        row = min(rows - 1, row + (params[0] or 1))
                    elif cmd == "C":
                        col = min(cols - 1, col + (params[0] or 1))
                    elif cmd == "D":
                        col = max(0, col - (params[0] or 1))
                    elif cmd == "J":
                        if params[0] in (2, 3):
                            screen = [[" "] * cols for _ in range(rows)]
                            row = col = 0
                    elif cmd == "K":
                        if params[0] == 0:
                            for k in range(col, cols):
                                screen[row][k] = " "
                    i = j + 1
                    continue

            elif nxt == "]":
                # OSC — skip to BEL or ESC\
                j = i + 2
                while j < len(data) and data[j] not in ("\x07", "\x1b"):
                    j += 1
                i = j + 1
                continue

            else:
                i += 2
                continue

        elif c == "\r":
            col = 0
        elif c == "\n":
            row = min(rows - 1, row + 1)
        elif c == "\b":
            col = max(0, col - 1)
        elif ord(c) >= 32:
            if 0 <= row < rows and 0 <= col < cols:
                screen[row][col] = c
            col = min(cols, col + 1)

        i += 1

    return ["".join(r).rstrip() for r in screen]


# ── Structural invariant extraction ───────────────────────────────────────────

def _find_separator_row(screen_rows: list[str]) -> int | None:
    """Return index of the first full-width separator row, or None."""
    for i, row in enumerate(screen_rows):
        stripped = row.strip()
        if len(stripped) >= MIN_SEPARATOR_LEN and all(ch == "─" for ch in stripped):
            return i
    return None


def _find_prompt_row(screen_rows: list[str]) -> int | None:
    """Return index of the row containing the '❯' input-prompt glyph."""
    for i, row in enumerate(screen_rows):
        if "❯" in row:
            return i
    return None


def extract_invariants(screen_rows: list[str]) -> dict:
    """Pull out the structural elements we'll compare across launches."""
    sep_row = _find_separator_row(screen_rows)
    prompt_row = _find_prompt_row(screen_rows)
    bypass_row = next(
        (i for i, r in enumerate(screen_rows) if "⏵⏵" in r or "bypass permissions" in r),
        None,
    )
    prompt_content = ""
    if prompt_row is not None:
        # Everything after '❯' and optional whitespace
        after = screen_rows[prompt_row].split("❯", 1)[1].strip()
        # Remove the cursor block character (U+2588 FULL BLOCK or U+258B etc.)
        after = re.sub(r"[\u2580-\u259f\u2588\xa0 ]+", "", after)
        prompt_content = after

    return {
        "separator_found": sep_row is not None,
        "prompt_found": prompt_row is not None,
        "bypass_found": bypass_row is not None,
        "prompt_content": prompt_content,
    }


# ── Reference capture ─────────────────────────────────────────────────────────

def _capture_reference_screen_sync() -> dict:
    """Blocking reference capture — runs in a thread executor."""
    import signal

    env = {
        k: v for k, v in os.environ.items()
        if not k.startswith(("FLOWPAD", "CLAUDE_PROJECT_DIR", "CLAUDECODE"))
    }
    proc = ptyprocess.PtyProcess.spawn(
        ["claude", "--dangerously-skip-permissions"],
        cwd=FLOWPAD_TEMP_DIR,
        dimensions=(24, 80),
        env=env,
    )
    fd = proc.fileno()
    output = b""
    deadline = time.time() + 3.0
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                output += os.read(fd, 4096)
            except OSError:
                break
    # Force-kill the process tree; don't wait (child may have sub-children)
    try:
        os.kill(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        proc.close()
    except Exception:
        pass

    screen = render_pty_screen(output)
    return extract_invariants(screen)


async def capture_reference_screen() -> dict:
    """Async wrapper: run blocking reference capture off the event loop."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _capture_reference_screen_sync)


# ── Claude Code section extractor ─────────────────────────────────────────────

def extract_claude_section(full_pty: str) -> bytes:
    """Return the PTY bytes starting from Claude Code's first MODE ON ?2004.

    This skips the shell prompt + shell echo, leaving only what Claude Code
    itself wrote to the terminal.
    """
    marker = "\x1b[?2004h"
    # The first occurrence is zsh turning on bracketed paste at its prompt.
    # The second occurrence is Claude Code doing the same as it initialises.
    first = full_pty.find(marker)
    if first == -1:
        return full_pty.encode()
    second = full_pty.find(marker, first + len(marker))
    if second == -1:
        return full_pty[first:].encode()
    return full_pty[second:].encode()


# ── Test ──────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
# do not increase timeout without approval
@pytest.mark.timeout(30)
async def test_clean_claude_pty_stress(bootstrapped_client):
    """Launch Claude 50 times; each PTY must structurally match a clean reference."""
    cn = await ComputeNode.get_one({"uname": "local"})
    assert cn, "No @local compute node found"

    # One-time reference: what does a clean Claude Code screen look like?
    ref = await capture_reference_screen()
    assert ref["separator_found"], "Reference launch missing separator — check claude is installed"
    assert ref["prompt_found"], "Reference launch missing ❯ prompt — unexpected UI change"
    assert ref["bypass_found"], "Reference launch missing bypass-permissions indicator"
    assert ref["prompt_content"] == "", (
        f"Reference prompt is not empty: {ref['prompt_content']!r}"
    )

    failures = []

    for i in range(ITERATIONS):
        process = AgenticProcess(
            compute_node_id=f"compute_node-{cn.id}",
            cli_config={"permission_mode": "bypassPermissions"},
            workdir=FLOWPAD_TEMP_DIR,
            visible=True,
        )
        await process.save([])

        try:
            await process.start()
            shell_id = process.shell_id
            assert shell_id, f"[iter {i}] process.start() did not set shell_id"

            await asyncio.sleep(SETTLE_SLEEP)

            pty_key = (cn.id, cn.node_provider_id, shell_id)
            chunks = replay_buffer.get_replay(pty_key, since_seq=0)
            full_pty = "".join(c.data.decode("utf-8", errors="replace") for c in chunks)
            assert full_pty, f"[iter {i}] No PTY output captured"

            # Render only the Claude Code section (skip shell echo)
            claude_bytes = extract_claude_section(full_pty)
            screen = render_pty_screen(claude_bytes)
            inv = extract_invariants(screen)

            problems = []
            if not inv["separator_found"]:
                problems.append("missing separator")
            if not inv["prompt_found"]:
                problems.append("missing ❯ prompt")
            if not inv["bypass_found"]:
                problems.append("missing bypass-permissions")
            if inv["prompt_content"]:
                problems.append(f"prompt not empty: {inv['prompt_content']!r}")

            if problems:
                failures.append(f"iter {i}: {'; '.join(problems)}")

        finally:
            await process.close()

    assert not failures, (
        f"{len(failures)}/{ITERATIONS} iterations had dirty PTY:\n" + "\n".join(failures)
    )
