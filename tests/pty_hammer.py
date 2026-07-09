"""PTY submit hammer — prove a hammered command + Enter actually SUBMITS.

One core, ``_hammer(target)``, drives every target identically: spawn a PTY,
then N times send ``<command>\\r`` (one write — text + Enter) and wait for proof
the line executed. Targets only differ in what they spawn and how "executed" is
detected:

  shell         bare shell (cooked mode). cmd ``echo "count:N"``; the needle
                ``count:N`` must appear TWICE (typed-echo + command output) — the
                second occurrence is the proof the Enter submitted.
  claude        claude TUI (raw mode + bracketed paste). cmd ``!printf 'MARK%sOK
                \\n' N`` runs a shell command with NO LLM call; the needle
                ``MARKNOK`` forms ONLY in execution output (never in the typed
                command), so ONE occurrence is proof — redraw-immune.
  claude-resume same as claude but against ``claude --resume <id>`` (the path the
                interactive worker uses), to catch a resume-specific submit hang.

Run as a script:   uv run python tests/pty_hammer.py [shell|claude|claude-resume]
Under pytest:      uv run pytest tests/pty_hammer.py -s
"""

from __future__ import annotations

import asyncio
import glob
import os
import re
import shutil
import tempfile
import time
import uuid

import pytest

ITERATIONS = 10
POLL_S = 0.05
# tests/conftest.py sandboxes HOME for isolation and stashes the real one here.
# claude must run under the REAL home (its auth/config + ~/.claude transcripts);
# unset (script run, no conftest) → the actual home.
_REAL_HOME = os.environ.get("FLOWPAD_PRE_SANDBOX_HOME") or os.path.expanduser("~")
CLAUDE_BIN = (
    os.environ.get("CLAUDE_BIN")
    or shutil.which("claude")
    or os.path.join(_REAL_HOME, ".local", "bin", "claude")
)
_CLAUDE_ENV = {"HOME": _REAL_HOME}  # overlay so claude uses real config, not the sandbox


def _transcript_has(cid: str, marker: str) -> bool:
    """True once *marker* appears in claude's session transcript JSONL.

    This is the REAL submission signal — the same user-message entry the
    interactive worker (``_run_pty_prompt``) waits on. Valid for injected input
    (unlike on-screen ``!`` bash output, which needs a typed ``!`` keystroke).
    """
    for path in glob.glob(os.path.join(_REAL_HOME, ".claude", "projects", "*", f"{cid}.jsonl")):
        try:
            with open(path, "rb") as fh:
                if marker.encode() in fh.read():
                    return True
        except OSError:
            pass
    return False
# Strip ANSI/VT so a needle survives a TUI's redraws.
_ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[\]P^_].*?(?:\x07|\x1b\\)|[\x00-\x08\x0b\x0c\x0e-\x1f]")

_CLAUDE_ARGV = [CLAUDE_BIN, "--dangerously-skip-permissions", "--model", "haiku"]


async def _prep_shell(provider, node_id, workdir):
    return {"spawn": None, "cid": None}


async def _prep_claude(provider, node_id, workdir):
    cid = str(uuid.uuid4())  # known id → known transcript path
    return {"spawn": [*_CLAUDE_ARGV, "--session-id", cid], "cid": cid}


async def _prep_claude_resume(provider, node_id, workdir):
    """Create a session (seed a turn so its transcript exists), then resume it."""
    cid = str(uuid.uuid4())
    seed = uuid.uuid4().hex
    await provider.get_or_create_pty_session(
        node_id, seed, lambda d: None, rows=40, cols=120,
        working_dir=workdir, spawn_args=[*_CLAUDE_ARGV, "--session-id", cid],
        extra_env=_CLAUDE_ENV,
    )
    await asyncio.sleep(8.0)
    await provider.send_pty_input(node_id, seed, b"seed\r", cols=120, rows=40)
    await asyncio.sleep(3.0)
    await provider.send_pty_input(node_id, seed, b"\x1b", cols=120, rows=40)  # stop generation
    await asyncio.sleep(0.5)
    await provider.close_pty_session(node_id, seed)
    return {"spawn": [*_CLAUDE_ARGV, "--resume", cid], "cid": cid}


# detect: "buffer" → needle in screen bytes (shell, cooked echo);
#         "transcript" → marker in the session JSONL (claude — the REAL submit
#         signal the worker uses, valid for injected input).
TARGETS: dict[str, dict] = {
    "shell":         {"prep": _prep_shell,         "detect": "buffer",     "min_occ": 2, "ready": 0.5, "budget": 5.0},
    "claude":        {"prep": _prep_claude,        "detect": "transcript", "min_occ": 1, "ready": 8.0, "budget": 12.0},
    "claude-resume": {"prep": _prep_claude_resume, "detect": "transcript", "min_occ": 1, "ready": 8.0, "budget": 12.0},
}


async def _hammer(target: str, iterations: int = ITERATIONS) -> list[dict]:
    """Spawn *target*'s PTY and hammer ``<marker>\\r`` N times, asserting each
    SUBMITTED. Returns [{n, ok, ms}]."""
    from flow_sdk.compute.providers.desktop.provider import (
        PTY_AVAILABLE,
        LocalComputeProvider,
    )
    from flow_sdk.flowpad_types import RuntimeEnvironment

    assert PTY_AVAILABLE, "PTY support not available (ptyprocess/pywinpty missing)"
    spec = TARGETS[target]
    is_claude = spec["detect"] == "transcript"
    run = uuid.uuid4().hex[:8].upper()
    workdir = tempfile.mkdtemp(prefix=f"hammer_{target}_")
    provider = LocalComputeProvider()
    provider.default_working_dir = workdir
    node_id = await provider.create_node(f"hammer-{target}", RuntimeEnvironment(name=target))
    await provider.startup(node_id)

    prep = await spec["prep"](provider, node_id, workdir)
    cid = prep["cid"]
    sid = uuid.uuid4().hex
    buf = bytearray()
    await provider.get_or_create_pty_session(
        node_id, sid, buf.extend, rows=40, cols=120, working_dir=workdir,
        spawn_args=prep["spawn"], extra_env=_CLAUDE_ENV if is_claude else None,
    )
    await asyncio.sleep(spec["ready"])

    results: list[dict] = []
    try:
        for n in range(1, iterations + 1):
            # Unique marker; the trailing 'Z' keeps marker_1 from matching marker_10.
            marker = f"{run}N{n}Z"
            # shell: ``echo "<m>"`` → output line. claude: ``<m>`` as a plain
            # prompt — submission lands a user-message entry carrying <m>.
            cmd = (f'echo "{marker}"' if not is_claude else marker).encode()
            mark = len(buf)
            t0 = time.monotonic()
            await provider.send_pty_input(node_id, sid, cmd + b"\r", cols=120, rows=40)

            ok = False
            deadline = t0 + spec["budget"]
            while time.monotonic() < deadline:
                if is_claude:
                    if _transcript_has(cid, marker):
                        ok = True
                        break
                elif _ANSI.sub(b"", bytes(buf[mark:])).count(marker.encode()) >= spec["min_occ"]:
                    ok = True
                    break
                await asyncio.sleep(POLL_S)
            results.append({"n": n, "ok": ok, "ms": round((time.monotonic() - t0) * 1000)})

            if is_claude:  # stop the LLM + clear input before the next prompt
                await provider.send_pty_input(node_id, sid, b"\x1b", cols=120, rows=40)
                await asyncio.sleep(0.4)
    finally:
        await provider.close_pty_session(node_id, sid)
        await provider.shutdown(node_id)
    return results


def _report(target: str, results: list[dict]) -> int:
    passed = sum(1 for r in results if r["ok"])
    avg = round(sum(r["ms"] for r in results) / max(len(results), 1))
    print(f"\n=== hammer: {target} ===")
    for r in results:
        print(f"  • {r['n']:>2}  {'OK ' if r['ok'] else 'FAIL'}  {r['ms']:>5}ms")
    print(f"  {passed}/{len(results)} submitted, {avg}ms avg")
    return passed


@pytest.mark.parametrize("target", list(TARGETS))
@pytest.mark.asyncio
async def test_hammer(target: str) -> None:
    # shell needs no claude; claude targets skip only when the binary is absent.
    if TARGETS[target]["detect"] == "transcript" and not os.path.exists(CLAUDE_BIN):
        pytest.skip("claude binary not found")
    results = await _hammer(target)
    passed = _report(target, results)
    assert passed == ITERATIONS, f"{target}: only {passed}/{ITERATIONS} submitted: {results}"


if __name__ == "__main__":
    import sys

    targets = [a for a in sys.argv[1:] if a in TARGETS] or list(TARGETS)
    rc = 0
    for tgt in targets:
        if _report(tgt, asyncio.run(_hammer(tgt))) != ITERATIONS:
            rc = 1
    raise SystemExit(rc)
