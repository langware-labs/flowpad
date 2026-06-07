---
id: cf4e2b89-56da-5eab-ac5b-9439cf00c7c0
---

# PTY fuzzer — replay-equivalence matrix

Validates the attach-time replay design: a framed PTY stream (output + resize
events) replayed through a headless terminal at the **recorded** sizes, then
serialized, must equal what a continuously-attached terminal shows.

Architecture spec: `docs/pty-terminal-spec.md` §10 (framed stream format) and
§13 (attach-time replay, design rules, upstream issues incl.
[xtermjs/xterm.js#6003](https://github.com/xtermjs/xterm.js/issues/6003)).

## Matrix axes

**1. Content strategies** (`strategies.sh`, bash, deterministic — validated by
`test_strategies_selfcheck.py`): plain_lines, ansi_colors, cursor_moves,
erase_repaint (ink/Claude-Code pattern), cr_overwrite, wide_utf8, long_wrap,
alt_screen, scroll_region, clear_screen, osc, sgr_styles, tabs_controls,
burst, save_restore_cursor, line_edits, incomplete_escape.

**2. Resize schedules** (harness-owned — bash cannot resize its own PTY):

| schedule          | description                                            |
| ----------------- | ------------------------------------------------------ |
| `none`            | fixed 100x30 throughout                                |
| `between`         | resize between strategy outputs                        |
| `mid-output`      | resize injected mid-strategy (worst case for ink)      |
| `shrink-grow`     | 120x40 → 60x20 → 100x30                                |
| `grow-shrink`     | 60x20 → 140x50 → 80x24                                 |
| `rapid`           | 5+ resizes in quick succession (drag-resize simulation)|

Every resize is recorded as a frame event at its exact byte offset in the
stream — that ordering is the correctness-critical part.

**3. Chunk-split schedules** (harness-owned; how the recorded stream is cut
into output frames / fed to the replayer):

| schedule          | description                                            |
| ----------------- | ------------------------------------------------------ |
| `whole`           | single chunk                                           |
| `pty-natural`     | chunks as the PTY read loop produced them              |
| `byte-by-byte`    | 1-byte chunks                                          |
| `mid-escape`      | split points forced inside CSI/OSC sequences           |
| `mid-utf8`        | split points forced inside multi-byte UTF-8 chars      |
| `seeded-random`   | random splits from a fixed seed (reproducible)         |

**4. Truncation points** (rolling-buffer behavior): no truncation /
truncate-at-frame-boundary / verify mid-frame truncation is impossible by
construction.

## Oracle

For each (content, resize-schedule, split-schedule) cell:

- **reference**: feed frames continuously into a `@xterm/headless` instance
  that lives through the whole session (resizing it at each resize frame).
- **candidate**: replay the same framed stream from disk into a *fresh*
  `@xterm/headless` (resizing at each resize frame), then
  `SerializeAddon.serialize()` → write into another fresh instance.

Pass = identical buffer text + cursor position + (where applicable) attributes.
The reference is what an always-attached user saw; the candidate is what a
refreshed client reconstructs.

## Findings (fuzz runs 1–3, 2026-06-06)

1. **xterm.js drops a multi-byte UTF-8 char when a `write(Uint8Array)` split
   leaves a `0x80` continuation byte in the decoder's interim state**
   (`[E2 80][94]` → em-dash lost; `[E2][80 94]` is fine; also bites 4-byte
   chars like `𐀀` split `[3][1]`). Root cause: `Utf8ToUtf32.decode()` counts
   stashed interim bytes by value-truthiness, and `0x80 & 0x3F === 0`.
   Reported upstream with repro (`xterm-utf8-split-repro.mjs`):
   **https://github.com/xtermjs/xterm.js/issues/6003**. Found via real Claude
   session streams (em-dash, `›`, and ZWJ are all `E2 80 xx`).
   **Design rule:** a replayer must decode
   bytes→string with a *streaming* `TextDecoder` before `term.write()` —
   exactly what the live path already does (`ptyConnection.appendOutput`).
   Never feed raw re-chunked `Uint8Array`s.
2. **xterm reflow converges**: content written at width A then resized to B
   equals content written directly at B (for the normal buffer). This is why
   naive replay only garbles when the replay width differs from the recorded
   width *and* the content exercises the width (wraps/cursor-relative
   repaints) — and why the H2 negative control must pick a naive size
   different from the recording's final size.
3. **Replay equivalence holds exactly** (text + cursor + buffer type) for all
   17 synthetic strategies × 6 resize schedules × 6 split schedules, plus
   serialize→restore, plus 3×3MB real Claude session streams — once feeding
   uses streaming string decode. No tolerances needed.
4. The old `PtyReplayBuffer` failure mode reproduces on demand: same bytes at
   a different width diverge for every width-exercising strategy (24/24 H2
   cells).

## Layout

- `strategies.sh` — content generators (bash, run under a real PTY).
- `test_strategies_selfcheck.py` — pytest: each generator emits the escape
  patterns it claims (runs under ptyprocess, POSIX-only; the equivalence
  matrix itself is platform-neutral since it consumes recorded streams).
- Equivalence matrix (vitest, `@xterm/headless`): see
  `ui/tests/unit/pty-replay-equivalence.test.ts` (task 3).
