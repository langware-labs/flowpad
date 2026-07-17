"""Cross-worker submit hammer over HTTP — ONE loop for every worker × transport.

Gated on PROCESS status (``ProcessStatus``, backend-owned, identical across
vendors) — NOT ``worker_status`` (per-vendor transcript-tail parsing). Drives the
refined ``input()``/``submit()`` API IDENTICALLY for visible (PTY) and headless,
against a running backend (default :9008).

Submission is detected cross-worker via ``POST .../transcript/prompts`` — the
marker shows up as a user prompt whatever the vendor's transcript format is. No
raw bytes, no worker_status, no per-vendor branches.

    input(marker); submit()                 # same call for every worker/transport
    wait: status == RUNNING (+ submit accepted, retry on 409)   # process-level
    validate: marker in transcript/prompts  # cross-worker

Run:  uv run python tests/long_tests/cross_worker_hammer.py
"""

from __future__ import annotations

import os
import shutil
import sys
import time
import uuid

import httpx

from flow_sdk.builtin.agentic_process.model_tiers import ModelTier

BASE = os.environ.get("FLOWPAD_HAMMER_URL", "http://localhost:9008").rstrip("/") + "/api/v1"
ITER = 10
DETECT_BUDGET = 8.0   # user-msg lands early; >8s = broken
TURN_BUDGET = 25.0    # serialize: wait out the turn (codex/copilot run ~15s) before next
AP = "/graph/agentic_process"
RUNNING = "running"
# worker_type → (CLI binary, model). Claude and Codex map the sm/md/lg tiers to a
# real model, so ask them for the cheapest one via the enum. Copilot is left unset:
# COPILOT_MODEL_TIERS still carries codex's names (gpt-5.4-mini/gpt-5.4) and the
# Copilot CLI rejects them ("Model ... is not available"). Its auto mode already
# picks claude-haiku-4.5 — its small tier — so unset is both correct and cheap.
WORKERS = {
    "claude_code": ("claude", ModelTier.SM.value),
    "codex": ("codex", ModelTier.SM.value),
    "copilot": ("copilot", None),
}


def _status(c: httpx.Client, pid: str) -> str | None:
    return (c.get(f"{AP}/{pid}").json().get("data") or {}).get("status")


def _wait_running(c: httpx.Client, pid: str, budget: float = 20.0) -> bool:
    end = time.monotonic() + budget
    while time.monotonic() < end:
        if _status(c, pid) == RUNNING:
            return True
        time.sleep(0.1)
    return False


_AWAITING = {"idle", "complete", "interrupted", "pending_user"}


def _wait_turn_done(c: httpx.Client, pid: str, budget: float) -> None:
    """Serialize: wait for the worker to finish the turn before the next submit,
    so slow codex/copilot turns don't pile a backlog. The status action's
    worker_status is the backend-derived, cross-worker completion signal."""
    end = time.monotonic() + budget
    while time.monotonic() < end:
        r = c.post(f"{AP}/{pid}/status", json={})
        ws = (r.json().get("data") or {}).get("worker_status") if r.status_code == 200 else None
        if ws in _AWAITING:
            return
        time.sleep(0.2)


def _transcript_text(c: httpx.Client, pid: str) -> str:
    # transcript/prompts — the USER-MESSAGE list. Cross-worker now that codex/copilot
    # headless resolve the rollout/session record (not the stdout tee that lacked
    # user-message entries). The marker (the prompt) lands here early in the turn.
    r = c.post(f"{AP}/{pid}/transcript/prompts", json={})
    return r.text if r.status_code == 200 else ""


def _pty_settle(c: httpx.Client, pid: str, budget: float = 18.0) -> None:
    """Wait for a visible TUI to finish drawing (PTY output stops growing)."""
    shell_id = (c.get(f"{AP}/{pid}").json().get("data") or {}).get("shell_id")
    if not shell_id:
        return
    prev, stable, end = -1, 0, time.monotonic() + budget
    while time.monotonic() < end:
        r = c.get(f"/graph/shell/{shell_id}/pty-stream")
        cur = len(r.text) if r.status_code == 200 else 0
        stable = stable + 1 if cur == prev and cur > 0 else 0
        if stable >= 6:  # ~0.6s with no new output ⇒ input box drawn
            return
        prev = cur
        time.sleep(0.1)


def hammer(c: httpx.Client, cnid: str, worker_type: str, transport: str) -> list[tuple[int, bool, int]]:
    pty = transport == "visible"
    wd = f"/tmp/xhammer_{worker_type}_{transport}_{uuid.uuid4().hex[:6]}"
    os.makedirs(wd, exist_ok=True)
    body: dict = {
        "context": {"workdir": wd, "worker_type": worker_type, "permission_mode": "bypassPermissions"},
        "visible": pty,
        "pty_mode": pty,
    }
    if WORKERS[worker_type][1]:
        body["context"]["model"] = WORKERS[worker_type][1]
    r = c.post(f"/graph/compute_node/{cnid}/createProcess", json=body)
    assert r.status_code == 200, f"createProcess {r.status_code}: {r.text[:200]}"
    pid = (r.json().get("data") or r.json())["id"]

    _wait_running(c, pid)          # process-level boot gate (cross-worker)
    if pty:
        _pty_settle(c, pid)        # PTY: TUI must finish drawing before typing
    else:
        # Headless boot gate: the FIRST print-mode turn pays the cold start
        # (spawn `<cli> -p`, load model). Warm it up here — submit a throwaway
        # and wait for it to land — so the measured loop isn't timing cold boot.
        # Mirror of the PTY settle; same role, both transports warm by turn 1.
        warm = f"WARM{uuid.uuid4().hex[:6].upper()}"
        c.post(f"{AP}/{pid}/input", json={"text": warm})
        c.post(f"{AP}/{pid}/submit", json={})
        wend = time.monotonic() + 8.0  # warm-up: bounded, not a grind
        while time.monotonic() < wend and warm not in _transcript_text(c, pid):
            time.sleep(0.2)

    run = uuid.uuid4().hex[:6].upper()
    markers: list[tuple[int, str, int]] = []  # (n, marker, submit_ms)
    for n in range(1, ITER + 1):
        marker = f"{run}N{n}Z"  # trailing Z so N1 doesn't match N10
        t0 = time.monotonic()
        _wait_running(c, pid)  # gate on PROCESS status, not worker_status
        # SAME two calls for every worker × transport.
        c.post(f"{AP}/{pid}/input", json={"text": marker})
        for _ in range(40):  # retry submit on 409 (process admission), never on success
            rs = c.post(f"{AP}/{pid}/submit", json={})
            if rs.status_code != 409:
                break
            time.sleep(0.25)
        # Serialize on the worker: wait out this (possibly slow) turn before the
        # next submit so no backlog forms. We do NOT detect per-turn — codex writes
        # the user-message early, copilot flushes its transcript late/batched, so a
        # tight per-turn window races the flush. Submission is validated at the END,
        # once the transcript has caught up (below).
        _wait_turn_done(c, pid, TURN_BUDGET)
        markers.append((n, marker, round((time.monotonic() - t0) * 1000)))

    # Final cross-worker validation: every submitted marker is now a user prompt
    # in the (caught-up) transcript. Brief retry for the last flush.
    text = ""
    end = time.monotonic() + DETECT_BUDGET
    while time.monotonic() < end:
        text = _transcript_text(c, pid)
        if all(m in text for _, m, _ in markers):
            break
        time.sleep(0.2)
    return [(n, marker in text, ms) for n, marker, ms in markers]


def main() -> None:
    c = httpx.Client(base_url=BASE, timeout=30.0)
    try:
        b = c.get("/graph/bootstrap", params={"domain": "localhost"})
    except Exception:
        print(f"backend not reachable at {BASE}")
        sys.exit(2)
    if b.status_code != 200:
        print(f"backend bootstrap {b.status_code}")
        sys.exit(2)
    cnid = (b.json().get("data") or {}).get("default_compute_node", {}).get("id")
    assert cnid, "no default compute node"

    only = [a for a in sys.argv[1:] if a in WORKERS]  # optional worker filter
    all_ok = True
    for wt, (binary, _) in WORKERS.items():
        if only and wt not in only:
            continue
        if shutil.which(binary) is None:
            print(f"\n=== {wt}: SKIP (no {binary}) ===")
            continue
        for transport in ("visible", "headless"):
            results = hammer(c, cnid, wt, transport)
            passed = sum(1 for _, ok, _ in results if ok)
            avg = round(sum(ms for *_, ms in results) / max(len(results), 1))
            print(f"\n=== {wt} / {transport} ===")
            for n, ok, ms in results:
                print(f"  • {n:>2}  {'OK ' if ok else 'FAIL'}  {ms:>5}ms")
            print(f"  {passed}/{ITER} via ap.input()/ap.submit(), {avg}ms avg")
            all_ok = all_ok and passed == ITER
    print(f"\n{'ALL GREEN' if all_ok else 'SOME FAILED'}")
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
