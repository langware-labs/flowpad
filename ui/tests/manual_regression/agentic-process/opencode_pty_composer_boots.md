---
id: c8603ff6-3903-4aea-9045-e0a3bc75e2c2
---

# OpenCode opener spawns a PTY whose TUI reaches its composer

**Area:** agentic-process / PTY spawn
**Vendor:** opencode (skips when the `harness.opencode.cli` capability is not `available`)

## Why this scenario exists

Every other worker-spawning scenario in the suite pins `claude`/`codex` — either by
passing an explicit `worker_type` to `createProcess` or by clicking
`opener-menu-row-claude`. Nothing drove an **opencode** session end to end, so the
argv the driver builds for the bare TUI was never exercised by a browser test.

That gap hid a real defect: `opencode run` accepts `--dir` and `--variant`, but the
bare interactive TUI (`opencode [project]`) accepts **neither** — it takes the
directory as a POSITIONAL. Emitting either flag made yargs print usage and exit 1,
so the PTY worker died before painting anything. A test that only checks "a process
entity was created" passes straight through that failure; only looking at the PTY
catches it.

## Steps

1. Open a shell tab (`/dock/shell/new_terminal`, advanced view mode).
2. Click the `+` tab-opener button.
3. Click the **OpenCode** row in the opener menu.
4. Observe the dock URL.
5. Observe the active terminal panel's rendered output.

## Expected

- Step 3: the opener menu offers an `opencode` row at all.
- Step 4: the URL becomes `/dock/shell/agentic_process-<uuid>` — a real process,
  not a bare shell and not the `new` placeholder.
- Step 5: the terminal paints opencode's composer placeholder **`Ask anything`**.
  This is the on/off switch for the argv class of failure: a TUI that rejected its
  arguments exits before the composer is ever drawn.

## Notes

`Ask anything` is the same marker the driver uses for
`pty_composer_ready_pattern`. Measured against opencode 1.18.18 it paints ~2.1s
after spawn in a raw PTY and ~11.5s end-to-end through the app. OpenCode paints no
directory-trust or login interstitial, so the marker is unambiguous — it appears
only once input is accepted.

