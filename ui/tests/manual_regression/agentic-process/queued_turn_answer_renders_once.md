---
id: d02732a5-26c7-4ae3-b206-afbf3e932655
---

test 1: A queue-drained turn's answer renders once in the Standard chat (FLOWPAD-2042)
- create a headless Claude process (compute_node/@local/createProcess, worker_type=claude_code, pty_mode=false),
  or reuse FP2042_PROCESS_ID — the race reproduces reliably on a LONG-HISTORY session; a fresh one usually wins it
- navigate to /dock/shell/agentic_process-<id>?viewMode=standard and wait for the chat pane + composer
- send a slow prompt: run `sleep 12` with the Bash tool, then reply with ALPHA-<run>-<n>
- wait until the turn is busy (Stop button visible)
- while it is busy, send a multi-step prompt: write a sentence, run `echo` with the Bash tool, then reply with ZEBRA-2042-<run>-<n>
  (the composer enqueues it; the backend drains it when the first turn ends — this pane did not start that turn)
- wait for ZEBRA-2042-<run>-<n> to appear and the turn to finish
- validate ZEBRA-2042-<run>-<n> appears exactly once in the chat pane, and no message row contains it twice
- repeat 3 times (the duplicate is a delivery race)
- reload the page and validate every answer still appears exactly once (the transcript holds one copy)
- `<run>` is unique per run, so a reused process's earlier answers are never counted

Guards FLOWPAD-2042: a queue-drained turn reaches the pane over two channels — the `observe-turn`
stream and the WS broadcast (`run_headless_turn` → `emit_flow_data`). When the observe-turn copy of the
final answer arrived first, its row was still open (not `ready`) when the WS copy landed, and
`_ingestRaw` consolidated the WS copy into that row → "ZEBRA-2042-…-1ZEBRA-2042-…-1". Fixed by
stamping each item with its client channel (`frontend-ev-source-type`) and letting a raw group grow
only from the channel that opened it. Without the fix this fails on the first drain (prod, long-history
session); with it, all three drains and the reload pass.
