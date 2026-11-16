---
id: 7081f426-abe8-4cc8-bba5-ab6b65cbcc1f
title: 'A terminal''s cold open: what it waits for'
tags:
- breadcrumb.test.terminal_cold_open.rules
description: A cold open from a checkpoint must not wait on a backend loop busy classifying
  screens, on a fetch started after the attach, or on re-parsing a checkpoint whose
  tail holds only resizes.
---
# A terminal's cold open: what it waits for

> Ground truth. Proven by RCA on 2026-11-16. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.terminal_cold_open.rules
sites:
  - rel_path: "ui/tests/manual_regression/navigation/tab_switch_perf.md.ts"
    line: 650
    note: "FAILING? a cold open waits serially or replays a checkpoint it need not - read this tag's rules first"
  - rel_path: "ui/tests/unit/pty-replay-checkpoint.test.ts"
    line: 63
    note: "FAILING? a cold open waits serially or replays a checkpoint it need not - read this tag's rules first"
```

## Expected behavior

Reopening a terminal with a large recording (3.9 MB screen, 50k-line scrollback) shows it within 1 s
(`tab_switch_perf.md.ts`, production build), measured from the switch's `start` to its cold `ready` line.

## Internals

* Backend: `AgenticProcess._watch_launch_screen` (`flow_sdk/builtin/agentic_process/agentic_process.py`) reads
  the worker's screen until its composer shows. It classifies at most every `LAUNCH_SCREEN_TICK_S` (0.1 s) and
  joins what queued meanwhile (`_OutputFeed.pending`, `flow_sdk/builtin/shell.py`). Classifying per chunk took
  a third of the event loop while a worker flooded its screen (py-spy: 1621 of 4769 loop samples), and every
  request of the open queued behind it.
* Client: `TerminalPanel` starts the runtime (`POST /open`, attach) and, for a terminal surface, calls
  `prefetchPtyReplay(shell_id)` (`pty-replay.ts`) at the same time. `useXtermShellAttach` takes it on the first
  attach (`mount` / `status`) only if it reaches the live output: the first live chunk follows on from its
  last seq, or none came and the attach reply's `latest_seq` (`PtyConnection.attachLatestSeq`) is not past it.
  Otherwise it fetches again, as before.
* `replayPtyStream`: a run of resize frames with no output between them replays as its last one; a tail of
  resizes only (each reopen records its attach size and a winsize jiggle), shorter than
  `CHECKPOINT_MIN_FRAMES`, returns the checkpoint as stored. Its serialized lines are unwrapped, so the view
  reflows them at its own width.

## Invariants

* Nothing per output chunk on the event loop that scans the screen.
* The recording fetch and replay never wait for `/open` + attach + xterm init.
* A prefetched recording is used only when it is contiguous with the live output.
* A result that becomes the next checkpoint keeps its true size (the resize-only shortcut stays below
  `CHECKPOINT_MIN_FRAMES`).

## Failure modes

* Measured on this VM, factor 1: cold open from the checkpoint 3008 ms -> 886-1184 ms; first open ever
  8973 ms -> ~3.0 s. Probe trail before: loader 1.6 s, `/open` 0.5-1.1 s, fetch 0.4-1.4 s, replay 0.8-1.0 s;
  after: attach 3-6 ms (prefetched), replay 0.4 ms.
* Remaining path (~0.9-1.1 s): loader ~0.2-0.35 s, commit/render, `POST /open` ~0.27 s, xterm init ~0.14 s
  (its 50 ms fit timer included) -- the xterm mounts only after `/open` returns.
