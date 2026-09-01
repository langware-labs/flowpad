---
id: 285cbcbd-6fba-46c4-b60c-c85bf5a52592
title: PTY turn cut off mid-generation
tags:
- breadcrumb.test.pty_turn_liveness.rules
description: A long PTY turn was truncated mid-generation and still reported outcome="success".
  The poller measured liveness from transcript writes alone, but a vendor writes an
  assistant message only once it is COMPLETE — so transcript silence is the normal
  state of a WORKING agent, and the inactivity fallback was reading a busy worker
  as idle.
---

# PTY turn cut off mid-generation

> Ground truth. Proven by RCA on 2026-08-27. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.pty_turn_liveness.rules
sites:
  - rel_path: "tests/unit/test_agentic_process_pty_turn_liveness.py"
    line: 166
    note: "FAILING? the PTY turn was cut off while the worker was still generating - read this tag's rules before touching the inactivity fallback or _pty_change_signature"
```

## Expected behavior

A PTY turn ends when the **worker** says it ended.

The user cannot see the transport. A prompt answered over PTY must return the
same complete answer it would have returned headless; "the turn was long" is not
a reason to lose its tail.

## Internals

* **Two independent turn-end signals**, and only one of them is authoritative.
  `_pty_turn_complete` (`agentic_process.py:3898`) recognizes the provider's own
  terminal marker — claude `turn_duration`, copilot `assistant.turn_end`, codex
  `event_msg.task_complete`. When it fires, the turn is genuinely over. Inactivity
  (`:4306`) is the **fallback** for when no marker lands.

* **The fallback measured the wrong thing.** `last_activity` was refreshed only
  from transcript growth: at `:4215` when the poll loop arms, and at `:4238` when
  a reparse yields entries beyond the watermark. Nothing else moved it.

* **Transcript silence is not idleness.** A vendor writes an assistant message to
  its JSONL **only once that message is COMPLETE**. For the whole time the model
  is thinking, generating, or running a tool, the file does not change. So the
  quantity the fallback measured — time since the last transcript write — is
  really *time since the last completed message*, which grows without bound during
  normal work. Silence is the steady state of a **working** agent, not a boundary.

* **The PTY is the liveness signal that was missing.** The vendor TUI repaints
  continuously while it works — spinner, token stream, tool output — so its
  session stream file grows the entire time the transcript is quiet.
  `_pty_change_signature` (`:4027`) stats that file via
  `shell.get_shell_record` (`flow_sdk/builtin/shell.py:77`) and
  `shell.shell_pty_stream_path` (`:82`), returning a `(size, mtime_ns)`
  `PtySignature` (`:4025`). The poll loop compares it each tick at `:4301` and
  refreshes `last_activity` on any change.

## The proven lever

Whether a PTY paint refreshes `last_activity` (the block at `:4301`).

| Direction | Observation |
| --- | --- |
| ON — paint counts as activity | the turn stays open for as long as the TUI paints; the stream closes only after the PTY goes quiet |
| OFF — transcript-only liveness | `the turn was cut off after 1.2s while the PTY was still painting`, with `inactivity_timeout=1.0` and a stream file painted every 0.15s throughout |

Flipping it is a one-file checkout of the pre-fix `agentic_process.py`; the bound
test fails in one direction and passes in the other, deterministically, with no
vendor CLI, hub, or backend involved.

## Invariants

* **Never treat transcript silence as a turn boundary on its own.** It is the
  normal state of a working agent. Any new turn-end heuristic keyed on "the file
  stopped changing" reintroduces this exact bug, and reintroduces it silently.

* **Widening the window is not the fix** The window has to
  outlast whatever the poller believes idleness is. Measured against transcript
  writes, that is *the length of a turn's silence* — unbounded, so no value is
  large enough. Measured against paints, it is the gap between two frames of a
  live TUI — milliseconds, so a small value is correct.

* **A missing liveness signal must degrade to the old behavior, never to a turn
  that never ends.** `_pty_change_signature` returns `None` on no shell, no stream
  file yet, or an unreadable stat, and the guard at `:4302` is
  `if pty_sig is not None and pty_sig != last_pty_sig`. Dropping the `is not None`
  half, or holding the turn open when the signal is absent, converts a truncated
  turn into a hung one.

* **Do not make the paint a turn-END signal.** It is a *liveness* signal only.
  The turn still ends on the provider marker or on inactivity; the paint moves
  where inactivity is measured from. A poller that closed on "the PTY stopped
  painting" would close on any idle-but-alive TUI.

## Failure modes

* **The vanishing answer.** The turn ends, the answer is absent or stops
  mid-sentence, and the UI shows a completed turn. Reproduces on any turn with a
  quiet stretch longer than the 15 seconds window — a slow tool call, a long think, an API
  retry — so it tracks task difficulty, which makes it look like a model problem
  rather than a transport one.

* **Vendor-dependent visibility.** A provider whose marker lands promptly rarely
  reaches the fallback at all, so the bug appears to affect only some workers.
  That is a property of marker timing, not of which vendors are correct.

* **A test can hide it by letting the transcript grow.** Any transcript write
  refreshes `last_activity` at `:4238` and papers over the missing signal. The
  bound test's transcript is created empty and **never changes** for the whole
  run, so the painted stream file is the only thing that can hold the turn open.
  A fixture that appends to the transcript to "keep the turn alive" passes against
  the broken code.
