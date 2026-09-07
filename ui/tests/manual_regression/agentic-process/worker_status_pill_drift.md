---
id: 3491ea94-d95c-4422-90b6-10d11cb5385c
---

FLOWPAD-2095: after a worker dies mid-turn and its transcript goes stale
(worker_status -> inactive), sending the NEXT prompt should read as "working"
on every surface at once. Today the bottom-of-chat activity line and the
composer's status pill disagree for a beat.

- PRECONDITION: Standard view (`?viewMode=standard`) — SimpleChatPane (the
  message list + ChatActivityLine) and the composer's status pill
  (ChatComposerBar `statusSlot`, data-testid="simple-chat-status") only render
  together in Standard/chat mode; Advanced view shows the raw xterm instead.

test: composer pill matches the activity line right after re-prompting an INACTIVE session
- navigate to {APP_URL}/dock/shell/new_terminal?viewMode=standard, open the tab-opener "+"
  (data-testid="opener-plus-button") and pick "Claude Code" (data-testid="opener-menu-row-claude")
- wait for the process to reach status=running with a session_id (poll GET
  /api/v1/graph/agentic_process/{id})
- send "Generate 1000 unique English words, one per line." through the composer
  (data-testid="entity-execution-input" + data-testid="entity-execution-send")
- poll the backend until busy=true (a real turn is in flight) and read session_id
- kill the underlying `claude.exe --resume <session_id>` OS process directly
  (SIGKILL, not the graceful interrupt endpoint) — this leaves the transcript's
  last JSONL entry with NO terminal marker (no end_turn / stop_sequence /
  interrupt) because nothing gracefully closed it out
- locate the transcript at ~/.claude/projects/<encoded-cwd>/<session_id>.jsonl
  and back-date its mtime by 310s (past worker_status.py's ACTIVE_SECONDS=300),
  via Node `fs.utimes` — no need to wait 5 real minutes, `is_active` is a live
  `stat()` check, not a cached/polled value
- confirm the backend now reports worker_status=inactive (status stays running,
  busy is false — the dead worker was reaped) — this is the precondition the
  bug needs: a terminal-looking worker_status on an otherwise-live session
- send a second message ("Are you still there?") through the same composer —
  this starts a brand-new turn (`isPrompting` flips instantly, client-side)
  while worker_status on the entity is still the stale `inactive` until the
  backend's next broadcast lands
- IMMEDIATELY (no extra wait) read both:
  - the activity line's label (data-testid="chat-activity-label")
  - the composer pill's label (title attribute / text on data-testid="simple-chat-status")
- EXPECTED (post-fix): neither reads "Inactive" — both agree a turn is running
- ACTUAL (pre-fix, FLOWPAD-2095): the activity line reads "Working" (it
  special-cases a terminal workerStatus while a turn is active — see
  ChatActivityLine.tsx's `isTerminalStatus` check) while the composer pill,
  which resolves straight through `getDisplayStatus` with no such override
  and no knowledge of the client-side `isPrompting` latch, still reads "Inactive"
  until the backend's `busy: true` broadcast arrives over the websocket

ROOT CAUSE (see RCA on FLOWPAD-2095): `ChatComposerBar`'s `statusSlot` derives
its label from `getDisplayStatus(indicatorProcess)`
(ts_sdk/src/process/agentic-types.ts) alone. `ChatActivityLine` avoids the same
trap only because it goes through `useTurnActivity`
(ui/src/components/entity-execution-panel/hooks/useTurnActivity.ts), which ORs
in the process's local `isPrompting` counter, AND applies its own
`TERMINAL_STATUSES` override before ever calling `getStatusLabel`. The two
surfaces never shared a hook — `ChatComposerBar` simply never adopted the one
`ChatActivityLine`, `EntityExecutionPanel` and `SimpleChatPane` already use.
