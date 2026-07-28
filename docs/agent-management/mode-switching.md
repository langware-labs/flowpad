---
id: 1471a0c6-8bd1-5013-a890-cf33bee47f97
---

# Mode Switching (Chat/Headless ⇄ Interactive PTY)

An `AgenticProcess` runs a single logical CLI session — one `session_id`, one
transcript — that can be presented through **two mutually-exclusive transports**:

| Transport | `WorkerMode` | Persisted intent | UI |
| --- | --- | --- | --- |
| Headless / print-mode (no PTY, streams JSON over `flowDataStream`) | `WorkerMode.CLI` (`"cli"`) | `pty_mode=False` | Chat pane (`SimpleChatPane`) |
| Interactive PTY terminal (live worker at a real TTY) | `WorkerMode.Interactive` (`"interactive"`) | `pty_mode=True` | xterm terminal |

Switching between them **kills/spawns the worker but never touches
`session_id` or the transcript** — the destination transport resumes the exact
same session. This is not just a view flip; it is a real lifecycle action.

`WorkerMode` is defined in
`flow_sdk/builtin/agentic_process/status_predicates.py:43` (`INTERACTIVE`,
`CLI`) and mirrored in `ts_sdk/src/process/agentic-types.ts`.

---

## Two fields, two jobs (do not conflate)

| Field | Meaning | Written by |
| --- | --- | --- |
| `pty_mode` | **Durable transport intent.** The single field that decides PTY vs headless routing and survives reload. | `switch-mode`, `_enter_cli_mode`, the PTY open tail |
| `visible` | **Tab visibility only** — whether the process shows as a terminal tab. Does *not* pick the transport. | `set-visible`, and seeded alongside `pty_mode` on a PTY open |

`AgenticProcess` field defs are in
`flow_sdk/builtin/agentic_process/agentic_process.py` (`visible`, then `pty_mode`).
Routing keys on `pty_mode` everywhere — the stale `headless == !visible` phrasing has
been removed from the `pty_mode` docstring. `visible` is tab chrome only. See
[docs/agent/agentic_process_statuses.md](../agent/agentic_process_statuses.md).

The historical project note "visible IS the mode key (not pty_mode)" is **stale**.
The current code routes on `pty_mode`:
- `prompt()` branches on `self.pty_mode` (`agentic_process.py:1824`), explicitly
  "NOT tab-visibility".
- the frontend loader attaches a PTY only when `process.pty_mode !== false`
  (`ui/src/routes/loaders/load-process.ts:199`).
`set-visible` (`agentic-process.ts:1904`) is decoupled: it toggles only `visible`.

---

## The switch flow

### Single seam

- **Backend:** `agentic_process.py` `switch_mode` action (`@action.post("switch-mode")`,
  `:1315`). Body: `{"mode": "interactive" | "cli"[, cols, rows]}`.
- **Frontend:** `AgenticProcess.switchMode(mode, opts?)`
  (`ts_sdk/src/process/agentic-process.ts:2360`).
- **UI caller:** `useSessionSurfaceReconcile`
  (`interactive-terminal/use-process-mode-switch.ts`), driven by the **View
  mode** — the one mode preference. Two controls write it: the footer
  `ViewToggle` and `TerminalModeSwitch.tsx`, the in-context twin mounted leftmost
  in the terminal header (a `ProcessToolbar` slot) and leading vibe's display tab
  strip (`WorkspaceChildStrip`). Each mount calls `useProcessModeSwitch` once (a
  second call would own a second, disagreeing `switching` state); the hook derives
  the transport and the readiness gate from the reactive entity itself.

**Every pick is URL-first.** Selecting a mode only navigates (`?viewMode=`); the
mounted URL is the single writer, adopting it via `useDockViewModeOverrideSync`.
So the mode is shareable, back-safe, and survives the URL. `viewMode` is threaded
through the shell loader's scope-align redirect (`ProcessRouteCarry`), which
otherwise rebuilds the URL and drops query options.

The one thing navigation cannot express is the TRANSPORT — the terminal surface is
an interactive PTY, vibe and chat are headless. That reconcile lives in an
**effect**, not the click handler, so it happens however the mode changed (either
control, or `window.setView()`). It fires on a mode CHANGE only, never on mount:
merely opening a session must not kill or spawn a worker.

(Historically this was a 2-state toggle in the bottom ribbon, then a separate
3-valued "chat mode" preference. The latter could drift out of sync with View
mode — both carried a `vibe`, and each control wrote only its own — so it was
folded into View mode.)

### → CLI (chat / headless)

Backend `_enter_cli_mode` (`agentic_process.py:1268`):
1. **Mid-turn guard:** if `_get_prompt_lock(self.id).locked()` → **409** ("a prompt
   turn is in flight; cannot switch mode"). Prevents two workers sharing one transcript.
2. If a shell exists and `is_running()`, call `exit()` (SIGTERMs the worker + PTY,
   **preserves** `shell_id` + `session_id` + transcript). An `exit()` that raises
   because the PTY is already dead is swallowed — a dead PTY *is* the desired end
   state (`:1288`). A genuine `ApiFailResponse` (other than "No active shell") is returned.
3. Reload the row (`get_by_id`) so the reset rides on the freshly-saved exit row,
   then set `visible=False` **and** `pty_mode=False`, and `save()`.
   - Rationale (`:1276`): `exit()` alone can't reset `visible`, because a plain
     `restart` (exit+start) must *keep* it True. The reset therefore lives only in
     the explicit mode-switch.

Frontend `switchMode(CLI)` (`agentic-process.ts:2369`):
- sets `_userInitiatedStop = true`, optimistically flips the cached `Shell` to
  `CLOSING`, POSTs `switch-mode {mode:"cli"}`, then sets `visible=false` /
  `pty_mode=false` and clears the pending latches.
- **Does NOT emit `restarted`** — `restarted` drives `attachPty`, which is wrong
  once the PTY is dead. The view's toggle handler owns the chat reconcile.

### → Interactive (terminal)

Backend `switch_mode` INTERACTIVE branch (`agentic_process.py:1340`):
- calls `_perform_open(instruction=None, visible=True, retry=True)` — the canonical
  PTY open path. `visible=True` persists `pty_mode=True` in the open tail
  (`:991`). `retry=True` clears any `start_failure` latch.

Frontend `switchMode(Interactive)` (`agentic-process.ts:2361`):
- optimistically sets `pty_mode=true` + pending latches, calls
  `start({ visible:true, retry:true, cols, rows })` (the same `open` path, so the
  live PTY attach happens client-side too), then emits `restarted` so
  `InteractiveTerminal` clears the xterm and re-attaches to the fresh PTY.

### UI-side reconcile (both directions)

`useProcessModeSwitch().select` (`use-process-mode-switch.ts`), after the
navigation described above:
- Skips the lifecycle call entirely when `transport === mode` — the URL already
  said everything there was to say. This is the common case, not an edge one:
  Standard view paints the chat pane over a perfectly live PTY, so picking
  `terminal` there means "show me the xterm", not "spawn a PTY". The test keys on
  the **transport** (`pty_mode`, held stable by the SDK desired-value latch), NOT
  on the chat skin — the skin preference lags under rapid switching, so a
  skin-keyed test could short-circuit a direction that has not actually landed.
- Otherwise guards `if (!process || switching || !awaitingUserInput) return;`,
  mirroring the control's own disabled gate (see below).
- Re-enables the control **immediately** once the transport switch resolves, then
  fires `process.loadHistory({ force: true })` in the **background** to pull in
  turns the *other* mode produced. History reconcile is deliberately not awaited
  (a large-session transcript parse is slow and would wedge rapid switching); the
  live WS stream keeps the pane current meanwhile.

---

## Preconditions & gates

### Mid-turn: rejected

A switch is only legal while the worker is **awaiting user input**
(`IDLE`/`COMPLETE`/`INTERRUPTED`/`PENDING_USER` — `isAwaitingUserInput`). Enforced
in three layers:
1. Backend `_enter_cli_mode` 409s on the prompt lock (`:1280`).
2. The switch's chat/terminal segments are disabled unless `awaitingUserInput`
   (the hook derives it from the reactive entity via `isReadyForInput`). Gating
   is per segment: a pick that needs no transport work — the segment already
   matching `pty_mode`, and the **vibe** segment, which only navigates — is never
   gated.
3. `select` re-checks `awaitingUserInput` as a belt-and-suspenders guard for
   non-click callers.

Note: the backend mid-turn guard only covers the **→CLI** direction (it lives in
`_enter_cli_mode`). The →Interactive branch goes straight to `_perform_open` with
no explicit prompt-lock check — it relies on the UI gate. See "Concerns" below.

### `has_resumable_session` — resume vs fresh start

When the destination is a PTY (or any relaunch), whether the worker relaunches
with `--resume <session_id>` depends on the **driver** having a transcript for
that id. The trait is `CliWorkerBaseDriver.has_resumable_session(process)`
(`cli_worker_base_driver.py:574`):

| CLI | `has_resumable_session` | `pins_resume_cwd` | Notes |
| --- | --- | --- | --- |
| **claude** | `session_id` present **and** `get_claude_session(id)` exists (`claude/driver.py:312`) | `True` (`:57`) | Pins `CLAUDE_PROJECT_DIR` + workdir to the source session's cwd on resume/fork (`agentic_process.py:1045`). Supports fork + plan mode. |
| **codex** | `session_id` present **and** `find_codex_session_jsonl(id)` exists (`codex/driver.py:284`) | `False` (`:61`) | Codex **mints its own rollout id**; a preassigned/PTY `session_id` codex never wrote has no rollout — `codex exec resume <unknown>` errors, so it starts fresh and captures the real id from the stream (`:127`). No fork, no plan mode. |
| **copilot** | `self._has_session(process)` — probes the file (`copilot/driver.py:249`) | `False` (`:56`) | `session_id` alone can't tell a resumable session from a fresh one; the file probe does (`:98`). Passes `session_id` vs `resume_session_id` based on the probe (`:116`). No fork, no plan mode. |

Why the gate matters: without it, resuming a session id the vendor never wrote
exits with an error on every launch — the origin of the "codex/copilot resume
exit-error" fix. `supports_plan_mode` is Claude-only (`claude/driver.py:317`);
codex/copilot return `False`.

### `start_failure` latch

A PTY that dies instantly latches `start_failure`; subsequent auto-recovery opens
refuse to relaunch (stops a 5-s respawn-forever loop). An **explicit** switch/restart
carries `retry=True` to clear the latch (`start_pty` docstring, `agentic_process.py:863`).
The INTERACTIVE switch branch and `switchMode(Interactive)` both pass `retry:true`.

---

## Headless routing (what `prompt()` does after a →CLI switch)

`prompt()` (`agentic_process.py:1806`) routes on `pty_mode`:
- `pty_mode=False` (headless) → `self.driver.headless_prompt(...)` (vendor print-mode,
  handles multi-step tool sequences; usable even before the AP is in the DB).
- `pty_mode=True` + worker alive → write to PTY stdin (continues session).
- `pty_mode=True` + worker dead → `start_pty(instruction)` (PTY relaunch, resumes).

`input`/`submit` route on `_is_live_pty()` (`:1839`) = `pty_mode and is_running()`.

The frontend view derivation (`InteractiveTerminal.tsx:162`): `isHeadless =
!embedded && process.pty_mode === false` **forces** the chat pane regardless of
the chat/terminal skin override, and the render skips mounting the xterm container
so no PtySync attach is attempted for a shell-less process.

---

## Restart vs. switch (adjacent, don't confuse)

- `restart()` (frontend `:2340`, backend `http_restart` `:1344`) = `exit()` +
  `start_pty()`, **keeps** `visible`/`pty_mode` (stays a terminal). Emits `restarted`.
- A **server-initiated** restart (e.g. worker runs `flow process restart` after
  installing an MCP, via `self-restart` `:1356`) pushes a `worker.restarted` entity
  event; `onEntityEvent` (`agentic-process.ts:2398`) re-emits it as the local
  `restarted` so the terminal re-attaches. This was the fix for the "switchToChat
  'restarted' attach-loop" — `switchMode(CLI)` must NOT emit `restarted`.

---

## Known gaps / robustness concerns (for arch review)

1. **~~Asymmetric mid-turn guard.~~ FIXED.** The mid-turn guard
   (`_reject_if_turn_in_flight`) now runs in `switch_mode` for **both** directions and
   keys on `status_predicates.is_turn_busy` — the same predicate that produces the
   wire `busy` status and the frontend toggle gate. It catches a native-xterm turn
   (which holds no prompt lock) via the worker status, so the 409 and the toggle can
   never disagree. See [docs/agent/agentic_process_statuses.md](../agent/agentic_process_statuses.md).
2. **Optimistic FE state before backend confirm.** `switchMode` sets
   `pty_mode`/`visible` locally before/around the round-trip and relies on
   `_pendingPtyMode`/`_pendingVisible` latches + `onEntityUpdate` to reconcile a
   disagreeing wire value. If the backend switch **fails** after the optimistic
   write (CLI branch sets `visible=false`/`pty_mode=false` only *after* `callAction`,
   so a throw leaves them unchanged — OK; but the Interactive branch sets
   `pty_mode=true` *before* `start()`, so a `start()` throw leaves `pty_mode=true`
   with no live PTY). The UI catch shows a notify.error but does not roll back
   `pty_mode` — worth verifying the loader/entity broadcast corrects it.
3. **Background history reconcile can lag / drop silently.** `loadHistory({force})`
   is fire-and-forget with only a `console.debug` on failure; on a large transcript
   the chat pane can show a stale view until the live WS stream fills it. No user-facing
   signal that reconcile is pending or failed.
4. **Per-CLI resume divergence is implicit.** Codex/copilot start fresh when their
   own store lacks the id, silently changing `session_id`. A switch→terminal on a
   never-written session id therefore does not truly "resume" — it starts a new
   rollout. This is correct behaviour but surprising; the transcript-continuity
   promise only strictly holds for claude and for sessions the vendor has written.
5. **Fork is Claude-only.** `pins_resume_cwd`/fork paths are gated to Claude; there
   is no cross-vendor fork-on-switch. Not a switch bug, but any future "switch +
   fork" UI must branch on the driver trait, not the options shape.
</content>
</invoke>
