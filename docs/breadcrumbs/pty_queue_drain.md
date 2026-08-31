---
id: 248d2e92-b44d-4f51-a4d1-2ac8ab65dcdc
title: Prompt queue didn't drain in PTY mode
tags:
- breadcrumb.test.pty_queue_drain.rules
description: A prompt enqueued in PTY mode never drained at all. The turn-end seam
  in _flush_transcript_change gates on (not current_busy and prev_busy), but prev_busy
  came from _last_broadcast_key — an INSTANCE attribute on an AgenticProcess that
  is re-hydrated fresh for every streamer event, so it always read back None and the
  edge was dead.
---

# Prompt queue didn't drain in PTY mode

> Ground truth. Proven by RCA on 2026-08-26. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.pty_queue_drain.rules
sites:
  - rel_path: "tests/unit/test_agentic_process/test_prompt_queue_drain_after_pty_turn.py"
    line: 131
    note: "FAILING? the prompt queue did not drain in PTY mode - read this tag's rules before touching the turn-end edge or _last_broadcast_key"
```

## Expected behavior

Queueing a prompt while the agent is working is the whole point of the queue:
the user types now, it runs when the worker frees up. A prompt enqueued mid-turn
must run **when that turn ends**, with no further user action.

This must hold for PTY and headless alike. The transport is an implementation
detail of how the turn runs; it is not something the user chose, and it must not
decide whether their queued prompt ever executes.

## Internals

* **The turn-end seam is in `_flush_transcript_change`**, gated on the busy→idle
  EDGE — `if not current_busy and prev_busy:` (`agentic_process.py:7806`), with
  the drain scheduled at `:7848`.

* **`prev_busy` was always `None`, so that edge never fired.** It is derived from
  `_last_broadcast_key`, which was a plain **instance attribute** — and
  `_route_to_ap` hydrates a **fresh** `AgenticProcess` for every streamer event.
  An instance attribute therefore dies with the event that set it and always
  reads back `None` on the next one. Instrumented at a real turn end:

  ```
  prev_busy=None current_busy=False edge_fires=False
  ```

  This is the root cause. Everything below is why nothing else covered for it.

* **The key is process-scoped now.** `_LAST_BROADCAST_KEYS` (`:570`) is a
  module-level dict keyed by AP id, reached through a property (`:7698` getter,
  `:7711` setter) so every call site still reads and writes it as ordinary
  per-process state. Same pattern as the other module-scoped state in this file
  (`_OPEN_LOCKS`, `_QUEUE_LOCKS`, `_PROMPT_WORKERS`), and for the same reason.

* **No other drain source could cover PTY.** There are exactly six in the file,
  and for a live PTY every one is unreachable or self-defeating:

  | source | line | reachable for a live PTY? |
  | --- | --- | --- |
  | `complete` | `:2303` | **no** — scheduled by `end_headless_turn` (`:2273`), headless only |
  | `submit` | `:3280` | **no** — `_submit` returns at `:3277` after `send(b"\r")` when `_is_live_pty()`; the drain below it is the headless branch, as its own comment says |
  | `chain` | `:2376` | **never bootstraps** — needs a successful pop, and no first pop can occur |
  | `enqueue` | `:2390` | fires, always declines — you only queue *while busy* |
  | `enable` | `:2420` | only if the user toggles the queue off and back on |
  | `ready` | `:7848` | the turn-end seam — dead until `prev_busy` was fixed |

  So the only PTY-reachable path was `enable`, a manual toggle that is no part of
  the queue flow. Headless self-heals at its own turn end via `complete`; **PTY
  never drained at all.**

* **A declined drain cannot recover on its own.** In `_maybe_drain_queue`
  (`:2327`) the readiness gate at `:2342` logs `drain_check … not_ready` and
  returns at `:2350` — inside `_QUEUE_LOCKS`, structurally above the
  `try/except/finally` whose `finally` re-arms the drain at `:2376`. That is
  supporting context, not the cause: it explains why the enqueue-time decline is
  terminal, and therefore why the turn-end edge is the only thing that could have
  saved it.

* **`_queue_ready`** (`:2223`) is deliberately a superset of `is_ready_for_input`:
  it also admits `PENDING_USER` and a cold **headless** AP for its first prompt.

* **`_schedule_queue_drain`** (`:2257`) returns early when no queue file exists,
  and `q.pop` persists the removal **before** `prompt()` is awaited. Together
  those make a repeated drain harmless — which is what allows the seam to be
  re-fired without a double-inject.

## The proven lever

Where `_last_broadcast_key` lives.

| Direction | Observation |
| --- | --- |
| ON — module dict (`_LAST_BROADCAST_KEYS`) | `prev_busy` survives re-hydration, the edge fires once per turn end, queue drains; `drain_check` shows `("ready","ok")` |
| OFF — instance attribute | `prev_busy=None current_busy=False edge_fires=False`; `still ['queued while busy']`, `drain_check=[('enqueue','not_ready')]` |

That log line is the fingerprint: **one `not_ready` and nothing after it** means
the queue was asked once, declined, and never asked again.

The transport is confirmed as the switch by the control test living beside the
bound one — `test_headless_control_the_same_prompt_drains_on_its_turn_end` runs
the identical scenario with `pty_mode=False` and passes, because
`end_headless_turn` schedules the `complete` drain.

## Invariants

* **Anything the transcript-flush path must remember across events is
  process-scoped, never an instance attribute.** `_route_to_ap` re-hydrates a
  fresh `AgenticProcess` per streamer event. An instance attribute there is not
  merely fragile — it is guaranteed to read back `None`, silently, with no error
  anywhere. Any change that returns `_last_broadcast_key` to instance state kills
  `prev_busy`, kills the edge, and un-fixes this.

* **PTY and headless must both have a turn-end drain.** They reach it by
  different routes (`end_headless_turn` vs the transcript flush edge). Adding a
  transport must add its route, or that transport silently loses the feature.

* **Every decline needs an owner for the retry.** If you add a bail to
  `_maybe_drain_queue`, name the event that will ask again. A bail with no
  re-asker is terminal — there is no error, no retry, and the log looks like a
  normal decline.

* **Do not move the retry into the bail.** Rescheduling from inside the not-ready
  path re-arms a drain against a worker that is still busy; it spins. The retry
  belongs on the event that changes the answer — the turn ending.

* **Re-firing the drain must stay safe.** `_schedule_queue_drain`'s no-queue-file
  early return, the empty/disabled bail, and pop-before-inject are what make that
  true. Do not reorder the pop after `prompt()`.

## Failure modes

* **The dead queue.** Prompts sit in the queue after the turn ends; the agent is
  idle and waiting; nothing ever runs them. Not "eventually" — in PTY mode the
  queue was a one-way box. Sending another message does **not** clear it: a PTY
  submit returns at `:3277` and never schedules a drain. Only toggling the queue
  off and on does, which is why the feature could look like it worked when
  someone happened to poke it.

* **Every entry, not just the first.** Because `chain` never bootstraps, this is
  not one lost prompt — the whole queue is inert. Turns submitted faster than they
  run (slow codex/copilot) pile up with nothing draining them.

* **Silent by construction.** A dead edge raises nothing. `prev_busy` is `None`,
  the gate is simply false, and the flush completes normally. There is no
  exception, no warning, and no failing assertion anywhere in production.

* **A test can hide it by dispatching only the turn-end event.** Production emits
  a streamer event for the turn's OWN writes and another at turn end. A test that
  dispatches only the second never records `busy=True`, so `prev_busy` is `None`
  for the same reason the bug was — and the edge cannot fire even when the code is
  correct. The bound test dispatches both, as production does.

* **Not proven — the edge's remaining gap.** The edge requires an earlier flush to
  have recorded `busy=True`. For the enqueue case that is guaranteed (the UI only
  offers "queue" once a broadcast said the agent is working, and that broadcast IS
  the flush that wrote the key). It is **not** guaranteed for a queue that is
  non-empty while the process reaches ready without a busy turn — prompts queued
  against a stopped session that then starts. `enable` is the only PTY-reachable
  fallback there, and it needs a manual toggle. Never exercised; treat it as
  unverified, not as a rule.
