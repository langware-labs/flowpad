---
title: Composer readiness is a generation property, not a recent-bytes property
tags: [breadcrumb.test.composer_readiness.rules]
description: The PTY composer-ready gate scanned only the last 64 KB of output, but a vendor paints its ready-marker solely on a FULL composer redraw — so after one chatty turn the marker sits megabytes behind, the gate blocks forever with no log line, and every prompt is delivered 15 s late by the blind last-resort fallback.
---

# Composer readiness is a generation property, not a recent-bytes property

> Ground truth. Proven by RCA on 2026-08-31. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.composer_readiness.rules
sites:
  - rel_path: "tests/unit/test_pty_composer_gate_scan_window.py"
    line: 60
    note: "FAILING? the composer-ready gate went blind because the vendor's marker fell outside the scanned slice - read this tag's rules before touching pump_composer_ready or _COMPOSER_SCAN_WINDOW"
```

## Expected behavior

A prompt submitted in the chat reaches the vendor CLI **immediately**.

The readiness gate exists for exactly one reason: a cold TUI can sit on a quiet
blocking interstitial (directory-trust, login), and typing into that eats the
prompt. The gate protects the *cold* case. It must never delay a composer that
has already booted — "the terminal has been chatty since" is not evidence that
the composer is unavailable.

## Internals

* **Delivery is deferred to the gate.** For a driver declaring
  `pty_composer_ready_pattern`, `agentic_process.py:4112` sets
  `needs_initial_type` and types nothing inline; the text goes through
  `_typed_pty_delivery` (`agentic_process.py:3843`) →
  `Shell.wait_for_composer_ready` (`shell.py:824`) → `pump_composer_ready`
  (`cli_worker_base_driver.py:1298`). Until the gate returns, **nothing has been
  typed at all**.

* **The snapshot is already generation-scoped.**
  `wait_for_composer_ready` reads
  `PtyStreamFile.read_output_snapshot_after_seq(session.generation_start_seq)`
  (`pty_stream_file.py:310`). The `.pty` file is reused across respawns, so the
  boundary is what separates lives: `pty_actions.py:424` stamps
  `generation_start_seq = session_state.seq` on respawn, and `:329` keeps only
  frames with `seq > boundary`. **That** is the protection against a pre-restart
  banner authorizing input into a new process — not any byte count.

* **The marker is a full-redraw artifact.** Claude's pattern
  (`claude/driver.py:115`) is `❯` + space + `Try "` or `─{3,}` — the border of
  the EMPTY composer box. Measured across live multi-MB streams: **1–22
  occurrences total**. An idle composer has no reason to repaint it, so once it
  scrolls past, it does not come back.

* **The gate cannot fail loudly.** `pump_composer_ready` is event-driven with no
  timeout; it returns `False` only when the PTY closes. A marker it cannot see
  means it waits forever, logging nothing.

* **The only rescue is 15 s late.** `agentic_process.py:4310` blind-types the
  prompt once the turn hits `inactivity_timeout`. That path is a last resort, not
  a delivery mechanism.

* **Readiness latches per generation.** `PtyState.composer_ready_seq`
  (`pty_session_manager.py:64`) records the verdict; `shell.py:865`
  short-circuits on it so a long session does not re-scan its whole transcript
  on every prompt. The latch cannot change the answer — it is a cost
  optimisation only.

## Invariants

1. **The snapshot is scanned WHOLE.** Its bound is the generation, never a byte
   count. Re-introducing `initial[-_COMPOSER_SCAN_WINDOW:]` re-introduces this bug.
2. `_COMPOSER_SCAN_WINDOW` bounds only the **incremental** buffer, where it has
   to hold nothing more than a marker split across consecutive paints.
3. Generation scoping — not bytes — is the safety property.
   `test_generation_scoped_history_ignores_old_composer_marker`
   (`tests/unit/test_codex_pty_composer_gate.py`) is its guard.
4. Readiness is **never inherited across a respawn**. Every respawn reachable
   from the Shell API builds a fresh `PtyState`, so the latch dies by eviction;
   the `> generation_start_seq` comparison covers a recovery respawn that reuses
   a live state and is **not exercised by any test** (verified by mutation).
5. **The gate must never gain a timeout.** "Give up after N seconds" is the
   banned symptom-masking move — a gate that cannot see the marker is a scan bug,
   not a patience problem.

## Failure modes

**Signature in the logs — three lines, and only one of them appears:**

```
prompt-pty: user turn never landed …          ← fires
prompt-pty: composer gate did not confirm …   ← absent
prompt-pty: composer never became ready …     ← absent
```

Those are the *only* exits from the gated-delivery path. The first firing while
the other two never do **proves the gate was blocked, not failed**. Corroborate
by timestamp: the user's row lands in the vendor transcript **0.2–2 s AFTER** the
warning, which means the blind fallback — not the gate — delivered the prompt.

**Proven on real data:**

* Reported session (process `174e4be1`, 2026-08-29): **19 of 19 turns**, every
  one stalled and blind-delivered.
* Live measurement, shell `8c5efa3f`: 5.9 MB of output, last marker
  **2,222,119 bytes back — 33.9× the 65,536-byte window.**
* **On/off lever**, four production shells × three flips each:
  `_COMPOSER_SCAN_WINDOW = 65536` → `composer_ready=False`; whole snapshot →
  `True`; reverted → `False`.

**User-visible consequence.** Every turn dead-airs for ~15 s. Worse, the chat
pane's prompt bubble is a client-only optimistic echo
(`ts_sdk/src/process/agentic-process.ts` `appendUserMessage`) and the backend
deliberately drops the transcript's USER_MESSAGE row from the live stream
(`agentic_process.py:4258`). A pane remount inside that 15 s window therefore
erases the question while the answer still streams in — an answer with no
question above it. See `ui/tests/api/forced_history_reconcile_keeps_undelivered_echo.test.ts`.

<!-- flowpad:capsule identity
version: 1
data:
  id: 2baf8c97-a4d4-416f-950a-10a1611152a4
flowpad:endcapsule identity -->
