---
id: 710237f2-1fbb-59b6-b1ef-9e00722d0e54
---

# Claude Code PTY scrolling — why the terminal scrollbar disappears

## Symptom

In a Flowpad shell/terminal dock running a Claude Code session, the mouse wheel
scrolls the content but **no scrollbar appears** and there's no sense of total
length or current position. Looks like a Flowpad CSS regression. It isn't.

## Root cause: Claude Code "Fullscreen rendering"

Recent Claude Code (v2.1.89+) ships an opt-in **Fullscreen rendering** mode
(`/tui fullscreen`, a.k.a. `CLAUDE_CODE_NO_FLICKER=1`). When on, Claude:

1. Draws on the terminal's **alternate screen buffer** (like `vim`/`htop`) — a
   scratch canvas exactly the window size, with **no scrollback behind it**.
2. **Captures the mouse** (mouse-tracking mode) — wheel ticks are forwarded to
   Claude as input instead of scrolling the terminal viewport.

Anthropic added this on purpose to kill flicker and keep memory flat in long
sessions. The documented trade-off is exactly this symptom: the conversation no
longer lives in terminal scrollback, so the terminal's native scrollbar and
`Cmd+F` stop working.

### Confirmed live (xterm.js diagnostics)

On a live Flowpad Claude session:

- `.xterm` element has the `enable-mouse-events` class → mouse tracking is on.
- `.xterm-viewport`: `scrollHeight === clientHeight` (e.g. `624 === 624`) → the
  terminal has **zero scrollback to scroll**. There is structurally nothing for
  a scrollbar to represent.

So the scroll you feel is Claude repainting its *own* internal viewport, not the
terminal moving. The terminal correctly shows no scrollbar because, in this mode,
it has no content of its own to scroll.

## Why a faithful scrollbar can't be synthesized *inside* this mode

A real scrollbar needs two numbers the terminal does not have here: total content
height and current scroll offset. The alternate buffer is just a window-sized
grid; there is no VT/xterm escape sequence by which an app reports "I have N lines,
I'm at line K." Any thumb drawn over the alt buffer would be fabricated and would
drift/jump. A draggable *relative* scrubber (emit wheel escape sequences to the PTY
on drag) is feasible, but it can't show a truthful absolute position.

## The real fix: leave fullscreen rendering → the genuine scrollbar returns

The fix is not to fake a scrollbar; it's to disable the alt-screen mode. Then the
conversation flows back into terminal scrollback and the real xterm scrollbar
returns, with true length and position.

Levers (most → least complete):

1. **`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`** — forces the classic renderer.
   Conversation back in scrollback → real scrollbar. Full fix.
2. **`/tui default`** inside Claude (or unset `CLAUDE_CODE_NO_FLICKER`) — same,
   persisted to `~/.claude/settings.json`.
3. **In-session, staying in fullscreen:** `Ctrl+O` (transcript mode) then **`[`**
   dumps the whole conversation into native scrollback on demand. Also
   `CLAUDE_CODE_SCROLL_SPEED=3` speeds up the in-app wheel.

### Flowpad-specific: the fix applies here (good case)

Flowpad launches `claude` **directly** in the PTY (see
`flow_sdk/builtin/agentic_process/cli_drivers/claude/cli.py`, which builds
`["claude", "--dangerously-skip-permissions", "--resume", …]`). It does **not**
use `claude attach`.

This matters: the docs note that for *attached/background* sessions fullscreen is
forced and `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` is ignored. Because Flowpad
spawns `claude` itself, injecting `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` into the
worker's PTY environment **would** restore the classic renderer (and the scrollbar)
across all Flowpad Claude sessions.

Trade-off: the classic renderer reintroduces some flicker and grows memory in very
long sessions — which is precisely why Anthropic made fullscreen the default path.
So this should be an **opt-in** Flowpad setting, not unconditional.

## Recommendation

- Quick confirmation: set `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` for a Claude
  worker and verify the terminal scrollbar returns before baking anything in.
- If adopted: add an opt-in Flowpad setting that injects that env var (and/or
  avoids `CLAUDE_CODE_NO_FLICKER`) where the Claude worker PTY environment is
  assembled.

## Sources

- Fullscreen rendering — Claude Code Docs: https://code.claude.com/docs/en/fullscreen
- Issue #42670 — alternate screen buffer kills all scrollback (v2.1.89+): https://github.com/anthropics/claude-code/issues/42670
- Issue #42002 — Terminal scrollback not working in long sessions: https://github.com/anthropics/claude-code/issues/42002
- Issue #38810 — captures mouse events in tmux, scrollback unusable: https://github.com/anthropics/claude-code/issues/38810
- xterm.js #802 — alternate screen buffer has a bad scrollback experience: https://github.com/xtermjs/xterm.js/issues/802
