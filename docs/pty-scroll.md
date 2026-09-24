---
id: 710237f2-1fbb-59b6-b1ef-9e00722d0e54
---

# Terminal scrolling and the mouse wheel — issues, fixes, worker behavior

The mouse wheel has broken in Flowpad several times, each time for a different
reason, and each time the report was the same: "the wheel does nothing". This
doc explains how scrolling works in a Flowpad terminal, logs every cause found
with its proof and fix, and records what each worker (Claude Code, Codex, …)
does to the terminal.

Add an entry to the [issue log](#issue-log) per new cause. Keep the status
column true: a fix is **shipped** only once it is on `release/v0.2` and in a
tagged release; a hot-patch into an installed wheel is wiped by the next upgrade.

## How a wheel tick scrolls a terminal

A terminal tab has **two possible scrollers**, and which one moves depends on
modes the program in the PTY sets:

| Program state | xterm buffer | Wheel goes to | What scrolls |
|---------------|--------------|---------------|--------------|
| Plain shell / classic renderer | normal (has scrollback) | xterm | xterm's viewport; the scrollbar is real |
| Fullscreen TUI with mouse capture (`?1049h` + `?1003h` + `?1006h`) | alternate (no scrollback) | the program, as an SGR report `ESC[<64;x;yM` (up) / `<65` (down) | the program repaints its own viewport; no xterm scrollbar |
| Alternate screen **without** mouse capture | alternate | xterm (converts to arrow keys) | nothing, unless the program handles arrows |

Two Flowpad mechanisms sit on the path and are where most bugs came from:

- **Attach-time replay** (`ui/src/components/terminal/interactive-terminal/pty-replay.ts`).
  On every re-attach (tab switch, reload, restart) the tab replays the recorded
  PTY stream through a headless xterm, serializes it, and writes the result into
  the visible terminal. Whatever modes that rebuild gets wrong, the tab inherits.
- **The PTY recording** (`PtyStreamFile`, `flow_sdk/compute/providers/desktop/pty_stream_file.py`),
  a rolling file that drops whole frames from the front when it reaches its cap
  ([the cap and the truncation rules](interface/pty-layer.md#ptystreamfile--framed-rolling-buffer)).

## Issue log

| # | Surface | Cause (one line) | Fix | Status |
|---|---------|------------------|-----|--------|
| 1 | Documents, side lists | Parked web-tab iframes sat invisibly over the content area and ate the wheel | `7e51343ff` — parked frames get `visibility: hidden` | Shipped v0.2.169 |
| 2 | Fullscreen TUI terminal | Recording's front-truncation cut the one `?1049h`; replay rebuilt the TUI on the normal screen | `b8d30acb7` — cap 10 → 30 MB, then `b96fc61b5` — the cut carries the modes still in force | Mitigated v0.2.171; fixed on `agent-local-deployment-2`, not released |
| 3 | Fullscreen TUI terminal | Replay restored mouse *tracking* but not the SGR *encoding*; X10 reports go to `onBinary`, which nothing forwards | `7ad9c50d9` — replay re-applies `?1006h` / `?1016h` | Committed on `agent-local-deployment-2`, not released; hot-patched into prod 0.2.174 on 2026-09-23 |
| 4 | Claude Code terminal | Claude Code fell back to its classic renderer; Flowpad respawned it into a replayed alternate screen | `b96fc61b5` — a respawn marks a new generation, which resets the dead process's modes | Fixed on `agent-local-deployment-2`, not released |

### 1 — Parked iframes swallowed the wheel (documents, lists)

**Symptom.** Markdown documents and the sidebar lists did not scroll with the
wheel. Clicks and scrollbar drags worked.

**Cause.** `PersistentIframe` (`ui/src/components/persistent-iframe.tsx`) parks
every web-app / web-URL iframe on `<body>` so it never reloads, positioned over
the content area where it was last shown, hidden only with
`opacity-0 pointer-events-none`. The frames are cross-origin, and Chromium
routes wheel scrolling to their surface regardless of `pointer-events`. Once any
web tab had been shown, the wheel over that area went to an invisible frame.

**Proof.** In the desktop app, hiding the parked portal containers
(`display: none`) made the document and list scroll; restoring them made the
wheel dead again. A scrollable box injected above them scrolled.

**Fix.** Parked wrappers also carry `invisible` (`visibility: hidden`), which
takes the frame out of hit-testing without unloading it.

### 2 — Truncated recording lost the alternate screen

**Symptom.** A fullscreen TUI tab scrolled erratically after a re-attach: xterm
showed a scrollbar over stacked old frames, the wheel went to the program, and
often nothing moved.

**Cause.** A fullscreen TUI emits `ESC[?1049h` once at startup. Once
`PtyStreamFile` dropped that frame from the front, the replay rebuilt the TUI on
xterm's *normal* screen, with scrollback, while mouse capture stayed on — two
scrollers fighting over one wheel.

**Proof.** Offline, the real recording through the real replay pipeline: as
recorded → visible terminal on the normal buffer with scrollback; with
`ESC[?1049h` put back → alternate buffer, no scrollback.

**Fix.** The cap went from 10 MB to 30 MB (`b8d30acb7`), which only postponed
it: a long session still crosses the cap. `b96fc61b5` fixes it — `_truncate_front`
computes the private modes still in force at the cut (alternate screen, mouse
tracking and encoding, cursor keys, focus reporting, bracketed paste, cursor
visibility) and carries them in a first output frame, which has no seq so
generation-scoped readers never see it.

### 3 — Replay dropped the mouse encoding

**Symptom.** After any re-attach, the wheel did nothing in a fullscreen TUI tab
until the program happened to re-send its mouse modes on a redraw. Intermittent
by nature.

**Cause.** `SerializeAddon` writes the mouse tracking mode (`?1003h`) but never
the encoding (`?1006h` SGR). The visible terminal came back with tracking on and
xterm's default X10 encoding. xterm emits X10 mouse reports on `onBinary`, not
`onData`, and `InteractiveTerminal` only forwards `onData` to the PTY, so every
wheel tick and click was dropped in the browser.

**Proof.** Live, in the desktop app: `activeEncoding` was `DEFAULT` and a wheel
produced `onData: []` with a report on `onBinary`; setting `?1006h` moved the
same wheel to `onData` as `ESC[<64;…M` and the tab scrolled. Confirmed end to
end against a probe program that requests SGR once and logs every byte it
receives: 5/5 reports arrived with the patch, 0/5 without.

**Fix.** `replayPtyStream` watches the program's encoding switches through the
headless terminal's parser and appends the last one to the serialized state.
Test: `ui/tests/unit/pty-replay-mouse-encoding.test.ts`. Forwarding `onBinary`
would not help: a TUI that asked for SGR does not act on X10 reports.

### 4 — Classic renderer inside a replayed alternate screen

**Symptom.** After a backend restart, every Claude Code tab ignored the wheel,
PageUp and PageDown. Keys typed into the prompt still arrived.

**Cause.** Claude Code started in its classic renderer (see
[the auto-disable trap](#claude-code)). On restart, the backend discards the
stale shell and spawns `claude --resume` under the **same** shell id; the tab
replays the old recording, which ends inside the killed fullscreen process's
alternate screen (it never wrote `?1049l`). The new classic process draws onto
that alternate screen: no scrollback in xterm, no in-app scroll in classic mode.

**Proof.** In the stuck tab: xterm alternate / tracking `any` / SGR; the wheel
report was sent and acknowledged; `x` + Backspace reached the prompt; wheel,
PageUp and PageDown produced no repaint in the recording. `/tui fullscreen` made
the recording gain a fresh `?1049h` and the wheel scrolled (Claude Code's
`Jump to bottom` bar appeared).

**Fix.** `b96fc61b5`: `start_machine_pty_session` calls
`PtyStreamFile.mark_new_generation()`, which appends a frame turning those modes
off before the new process writes, so a classic process never inherits a
fullscreen screen. `/tui fullscreen` remains the workaround for a session on a
release that does not have it yet.

## Worker-specific behavior

Flowpad launches each worker CLI **directly** in the PTY
(`flow_sdk/builtin/agentic_process/cli_drivers/<worker>/`), so a worker's own
environment variables and settings apply as they would in a local terminal.

### Claude Code

**Fullscreen rendering.** Since v2.1.89 Claude Code has a fullscreen renderer
(`/tui fullscreen`, the `tui` setting, or `CLAUDE_CODE_NO_FLICKER=1`), which
Anthropic chose to kill flicker and keep memory flat in long sessions. In it
Claude Code behaves as row 2 of [the table above](#how-a-wheel-tick-scrolls-a-terminal):
it owns the wheel and scrolls its own viewport a few lines per tick (`PgUp`/`PgDn`,
`Ctrl+Home`/`Ctrl+End` too), and the tab shows no xterm scrollbar because the
alternate buffer has nothing to scroll. A faithful scrollbar cannot be
synthesized: no escape sequence reports "N lines, at line K".

Three levers, if the real scrollbar is what you want:

1. `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` — forces the classic renderer; the
   conversation returns to xterm scrollback.
2. `/tui default` inside Claude Code (or unset `CLAUDE_CODE_NO_FLICKER`) —
   same, persisted to `~/.claude/settings.json`.
3. Staying in fullscreen: `Ctrl+O` (transcript mode), then `[` writes the whole
   conversation into native scrollback on demand.

Flowpad spawns `claude` itself, not `claude attach` (where fullscreen is forced),
so lever 1 could be applied to every Flowpad Claude session by adding it in
`build_worker_spawn_env` ([cli-drivers.md](interface/cli-drivers.md#per-cli-matrix)).
It trades back flicker and memory growth, so it belongs behind an opt-in setting
rather than on by default — nothing tracks that proposal today.

**Mouse knobs.** `CLAUDE_CODE_DISABLE_MOUSE=1` stops mouse capture (the wheel
then no longer scrolls inside Claude Code); `CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1`
keeps the wheel but drops clicks; `CLAUDE_CODE_SCROLL_SPEED=<n>` scales the
in-app scroll.

**The auto-disable trap.** Claude Code counts fullscreen starts that don't
finish (a process killed during boot — a backend restart, a crash). After two it
writes `fullscreenAutoDisabled` (`{version, at, strikes}`) into `~/.claude.json`
and starts every later session **on the machine** in the classic renderer,
overriding `"tui": "fullscreen"`, until Claude Code updates or `/tui fullscreen`
is run. A healthy fullscreen start logs `fullscreen boot canary: healthy` in
`~/.claude/debug/<session>.txt` (sessions launched with `--debug`); a classic
start logs nothing. This is what set up [issue 4](#4--classic-renderer-inside-a-replayed-alternate-screen).
`/tui fullscreen` relaunches the process in place (same PID) and drops launch
flags such as `--debug`.

*Only Claude Code has been investigated — no wheel issue has been traced to
Codex, Copilot, OpenCode or Deep Agents yet. When one is, add a section here
saying which modes that worker sets (`?1049h`, `?1000/1002/1003h`, `?1006h`) and
whether it scrolls its own viewport.*

## Diagnosing the next one

Work down the path; the first layer that loses the wheel is the cause.

1. **Browser.** DevTools on the desktop app (View → Toggle Developer Tools).
   `document.elementsFromPoint(x, y)` at the pointer: anything above the target
   that isn't its own element (issue 1)? A capture-phase `wheel` listener shows
   whether the event arrived and whether it was `defaultPrevented`.
2. **xterm state.** The live `Terminal` hangs off the `.xterm` element's React
   fiber (a ref whose `current.element === el`). Read `buffer.active.type`,
   `modes.mouseTrackingMode`, `_core.coreMouseService.activeEncoding`,
   `buffer.active.baseY`. A fullscreen TUI on the normal buffer → issue 2.
   Encoding `DEFAULT` with tracking on → issue 3.
3. **xterm output.** Subscribe `term.onData` / `term.onBinary`: does a wheel
   produce `ESC[<64;…M` / `<65`?
4. **Delivery.** The `pty` toplog tag logs dropped input on both sides; a clean
   send is not logged. Which line answers which symptom is the catalog's job —
   `.claude/skills/toplog/tags.md` → `### pty`. For positive proof, wrap the
   tab's `shell.sendInput` and time the acknowledgement.
5. **The program.** Did it repaint? Compare the size of
   `~/.flow/instances/<name>/records_data/shell/<shell-id>/<pty-pid>.pty` before and after
   a wheel. Keys arriving but PageUp not scrolling → the program has nothing to
   scroll (issue 4); check the worker section above.

Before typing anything into the desktop app, confirm by screenshot that the
DevTools console has focus: keystrokes that land in a Markdown editor are saved
and auto-committed, and keystrokes that land in a terminal reach a live session.

## Related

- [pty-terminal-spec.md](pty-terminal-spec.md) — byte paths and attach-time replay.
- [interface/pty-layer.md](interface/pty-layer.md) — `PtyStreamFile` cap and the replay route.
- [pty-sync.md](pty-sync.md) — the attach sequence (`onConnected`).

## Sources

- Fullscreen rendering — Claude Code Docs: https://code.claude.com/docs/en/fullscreen
- Issue #42670 — alternate screen buffer kills all scrollback (v2.1.89+): https://github.com/anthropics/claude-code/issues/42670
- Issue #42002 — terminal scrollback not working in long sessions: https://github.com/anthropics/claude-code/issues/42002
- Issue #38810 — captures mouse events in tmux, scrollback unusable: https://github.com/anthropics/claude-code/issues/38810
- Issue #72215 — fullscreen: scrolling fully broken once output exceeds one screen: https://github.com/anthropics/claude-code/issues/72215
- Issue #70724 — fullscreen + `CLAUDE_CODE_DISABLE_MOUSE=1`: wheel navigates prompt history: https://github.com/anthropics/claude-code/issues/70724
- xterm.js #802 — alternate screen buffer has a bad scrollback experience: https://github.com/xtermjs/xterm.js/issues/802
