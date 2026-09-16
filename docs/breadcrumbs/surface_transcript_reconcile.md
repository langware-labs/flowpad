---
id: eb30bc0e-517c-4aea-8381-4f0c9cf42ed1
title: Surface change must reconcile the transcript
tags:
- breadcrumb.test.surface_transcript_reconcile.rules
description: A surface change owes BOTH obligations in both directions — the transport
  (leaving the terminal must switch the worker back to cli, or pty_mode stays latched
  forever) and the transcript (a forced history reload, because the mount-time
  loadHistory() no-ops on a latch nothing ever resets).
---

# Surface change must reconcile the transcript

> Ground truth. Proven by RCA on 2026-08-20 (the transcript obligation is
> symmetric), amended on 2026-09-08 by FLOWPAD-2105 (so is the TRANSPORT
> obligation — the round trip was restored), and on 2026-09-09 by a live
> reproduction showing the gate must mirror the server per ROUTE and cannot
> substitute for the missing `open` guard (FLOWPAD-2117).
> Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.surface_transcript_reconcile.rules
sites:
  - rel_path: "ui/tests/react/process-surface-startup-reconcile.test.tsx"
    line: 61
    note: "EDITING use-process-surface? read this tag's rules first - the surface owns the transport in BOTH directions, and the gate mirrors the SERVER PER ROUTE (switch-mode 409s while busy; open has no guard, so neither does the client). This file stubs loadHistory and does NOT cover the transcript half"
```

## Expected behavior

Switching the footer `ViewToggle` between Terminal and Vibe/Chat is **navigation**
(`?viewMode=`). The one thing navigation cannot express is the transport, so
`useProcessSurface` reconciles it. Two separate obligations hang off that
transition, and **both are symmetric**:

1. **Transport** — a terminal surface requires a live PTY; chat and vibe require
   the headless one. They can *render* either (`flowDataStream` is
   transport-independent), but `pty_mode` is the session's DURABLE transport
   intent, so leaving it true after the user walked out of the terminal made it
   a one-way latch. FLOWPAD-2105 restored the round trip.
2. **Content** — the incoming pane must end up showing everything the backend
   already has, *including the turns the outgoing surface produced*. This
   applies in every direction, chat→vibe included, where no transport changes at
   all.

After `terminal → vibe`, a turn typed into the xterm must appear in the vibe
pane without a page reload, and the worker must be back on `pty_mode=false`.

## Internals

* **`useProcessSurface`** (`ui/src/components/terminal/interactive-terminal/use-process-surface.ts`)
  is the only production caller of `switchMode`, at `:223`, and since
  FLOWPAD-2105 it passes **both** directions. They are not the same round trip:
  `WorkerMode.Interactive` goes through `start()` / the `open` action (it has to
  attach a live PTY, and `_perform_open` is the only thing that sets
  `pty_mode=True` — `agentic_process.py:1706`), while `WorkerMode.CLI` is the
  `switch-mode` action, whose `_enter_cli_mode` (`agentic_process.py:2057`)
  kills the PTY and persists `visible=False` + `pty_mode=False`. Dimensions are
  passed on the terminal direction only; the headless one has no grid to size.

* The transport-already-matches branch is at `:174`, and the `!wantPty` half of
  it is where the `loadHistory({ force: true })` reconcile lives for a surface
  change that moves no worker (chat⇄vibe). Before FLOWPAD-2013 that branch
  early-returned outright and the reconcile existed only after a switch
  (`:235`), i.e. only on `vibe → terminal`.

* **The gate mirrors the SERVER PER ROUTE** — `surfaceTransportGate` (`:68`),
  read by BOTH this effect and the footer `ViewToggle`'s greyed-out state, so
  the control can never offer a switch the effect would refuse nor refuse one
  the server would have honoured. `blocked === backend_refuses` on every row of
  the shared truth table (`test_fixtures/status_sets.json`).

  The two directions do not share a route, and therefore do not share a guard:

  | direction | route | backend guard | client |
  | --- | --- | --- | --- |
  | `→CLI` | `switch-mode` | `_reject_if_turn_in_flight` 409s on `is_turn_busy` | blocks while busy |
  | `→PTY` | `start()` / `open` | **none** | does not block |

  It is a mirror of the VALUE, not a reimplementation: the wire `busy` field IS
  `is_turn_busy(...)` computed on the backend (`agentic_process.py:7147`) and
  serialized, and `isBusy(p)` is `p.busy === true`. The two cannot disagree on
  logic — only on the freshness of the snapshot, which is why the server, not
  the client, has to be the thing that actually refuses (see the failure modes).

  Deliberately NOT readiness. `isReadyForInput` is false for two states with no
  turn in flight — a FAILED session, and a PTY ended with `/exit` (STOPPED) —
  so gating on it greys the control on a dead session under the words "not while
  the agent is working" and removes the two clicks that recover it: `→PTY`
  carries `retry: true`, and `→CLI` is what clears the `pty_mode` latch.

* **`_historyLoaded` is a one-way latch.** `AgenticProcess.loadHistory`
  (`ts_sdk/src/process/agentic-process.ts:1930`) returns immediately at `:1934`
  when `this._historyLoaded && !force`. The field is declared at `:1473`, set at
  `:2030`, and **nothing in the SDK ever resets it** — not a remount, not a
  surface change. So the mount-time `loadHistory()` at
  `EntityExecutionPanel.tsx:382` is unforced and a guaranteed no-op for any
  session already opened once this page load.

* **A PTY-produced turn has no other route into the pane.** The two sources are:
  * the sender's own `prompt()` response stream — but a turn typed into the
    xterm was never sent by this client, so no such stream exists;
  * `useObservedTurn` (`ui/src/components/entity-execution-panel/hooks/useObservedTurn.ts:45`),
    which opens `observe-turn` only while a pane is **mounted** and the turn is
    **live**. The vibe pane was unmounted for the whole terminal turn.

  With both dead, the pane renders a `flowDataStream` frozen at the last row it
  happened to see.

* Backend-side, transport routing keys on **`pty_mode`**, never on `visible`:
  `agentic_process.py:3555` — `if self.pty_mode: return self._run_pty_prompt(message)`.
  `visible` is tab chrome only. Several UI comments still claim otherwise; they
  are wrong.

* `pty_mode` **was** a one-way latch — it went `false → true` on
  `vibe → terminal` and nothing in `ui/src` ever wrote it back, not even a page
  reload. That is the FLOWPAD-2105 bug and it is fixed: leaving the terminal now
  writes it back. One case still does not, deliberately — **first sight never
  mutates** (`:168`), so opening a dock in chat on a session that is already
  `pty_mode=true` records the mode and leaves the worker alone. "The mode this
  dock opened in" is not a statement that the user left the terminal. A rule
  about the vibe pane must therefore still hold with `pty_mode` true; it is now
  the exception rather than the steady state.

## The proven lever

Force the history reload on the surface the pane is entering.

```diff
     if (!wantPty) {
+      if (!awaitingUserInput) return;
       lastReconciledMode.set(key, viewMode);
+      void live
+        .loadHistory({ force: true })
+        .catch((err) => console.debug('[sessionSurface] surface reconcile deferred:', err));
       return;
     }
```

| Direction | Action | Observation |
| --- | --- | --- |
| ON | `force: true` | new PTY turn `RCAMARKERBRAVO` rendered — bug gone |
| OFF | reverted | new PTY turn `RCAMARKERCHARLIE` missing — bug back |

Same session, same backend, an independent marker per direction. The backend
held all markers throughout (107 items) — this is a **client-side render gap,
never data loss**. Committed as `b180f6ffb` on `FLOWPAD-2013`.

Before theorising, both dead paths were instrumented and confirmed to actually
execute:

```
EARLY-RETURN no-reconcile from=advanced to=vibe ptyMode=true historyLoaded=true items=69
EEP mount loadHistory() historyLoaded=true items=69
```

### The second lever — FLOWPAD-2105, the transport half

Let the non-PTY direction reach `switchMode` instead of returning above it.

```diff
-    if (!wantPty) {
-      if (turnInFlight) return;
-      lastReconciledMode.set(key, viewMode);
-      void live.loadHistory({ force: true }).catch(…);
-      return;
-    }
     if (wantPty === ptyMode) {
+      if (!wantPty) {
+        if (turnInFlight) return;
+        void live.loadHistory({ force: true }).catch(…);
+      }
       lastReconciledMode.set(key, viewMode);
       return;
     }
     if (!canSwitch) return;
-    if (!awaitingUserInput) return;
+    if (wantPty ? !awaitingUserInput : turnInFlight) return;
     …
-        await live.switchMode(WorkerMode.Interactive, getDims?.());
+        await live.switchMode(
+          wantPty ? WorkerMode.Interactive : WorkerMode.CLI,
+          wantPty ? getDims?.() : undefined,
+        );
```

| Direction | Action | Observation |
| --- | --- | --- |
| ON | patch applied | 7/7 in `process-surface-startup-reconcile.test.tsx` |
| OFF | patch reverted | 4/7 fail — every `→cli` assertion sees 0 calls |

The four that flip are the round trip itself, the drain re-running into a real
`→cli` transition, the mid-turn deferral, and the `/exit`-STOPPED session. The
three that stay green are the first-sight rules, which the patch does not touch.

## Invariants

* **A surface change reconciles content in BOTH directions.** Adding a branch to
  `useProcessSurface` that returns without either switching transport or
  reloading history reintroduces this bug. Note the transcript obligation is the
  wider of the two: chat→vibe moves no worker and still owes the reload.

* **Force-reload only at idle.** `loadHistory({ force: true })` REPLACES the
  stream with the on-disk transcript, so a frame not yet persisted is dropped.
  Guard on `isBusy` (`turnInFlight`, `:149`) — this is `loadHistory`'s
  documented force-path contract, not a local preference. It was `isReadyForInput`
  until FLOWPAD-2105: readiness also demands a LIVE worker, so it skipped exactly
  the session whose turns can only be recovered from disk — one ended from the
  xterm with `/exit`, which is neither busy nor ready.

* **Leave the mode unrecorded when you decline mid-turn.** Not writing
  `lastReconciledMode` is what makes the effect retry the moment the worker goes
  idle; recording it strands the session unreconciled. Both guarded returns —
  the transcript reload at `:195` and the transport switch at `:213` — depend on
  this.

* **Never treat a mount-time `loadHistory()` as a repair.** It is unforced, so
  it is a no-op on any process this page load has already loaded. If a pane
  needs to converge with disk, it must force, or use a hook that does
  (`useTurnCompletionReconcile`).

* **Never kill a worker to enter chat or vibe WITHOUT the busy guard.** This
  invariant used to read "never kill a worker to enter chat or vibe" outright:
  `bf9b5170` had removed that path for cause — it killed healthy PTYs on a view
  change and silently queued the kill when the backend refused mid-turn (409).
  FLOWPAD-2105 established that this was a GUARD defect, not a reason to leave
  `pty_mode` latched, and restored the transport obligation with the guard split
  by direction (see Internals). What survives of the old rule is its real
  content: **a refused switch must never become a queued kill that fires while
  the user is back in the terminal.** The mode is left unrecorded on refusal so
  the effect retries at idle, and if the user has returned to a terminal mode by
  then, `previous === viewMode` makes that retry a no-op.

* **Both directions of the round trip must stay reachable.** `switchMode` is the
  only production path to either, and `useProcessSurface` is its only caller —
  so a branch that returns before the switch silently re-latches `pty_mode`. That is
  invisible in the network log (the defect is an absence) and shows up much
  later as a chat surface sitting on a live PTY.

## Failure modes

* **The frozen pane.** After `terminal → vibe` the pane shows the last
  pre-switch message and nothing after it. Measured: backend `get-history` 85
  items, client `flowDataStream` 69. A full page reload fixes it, which is the
  tell — a reload constructs a fresh `AgenticProcess` with `_historyLoaded`
  false, so the unforced mount load actually runs.

* **`terminal → vibe` fired zero transport requests.** Only a tab-activate and a
  prefs write. If you are looking at a network log for the bug, there is nothing
  to see; the defect is an absence. Since FLOWPAD-2105 there IS one request to
  look for — `POST …/switch-mode {"mode":"cli"}` — and its absence is now itself
  the symptom of a re-latched `pty_mode`.

* **A client gate cannot close the mid-turn window, and must not be trusted to.**
  Observed on 2026-09-09 against a live instance: prompt in chat, switch to
  Terminal in the same beat, and the access log reads

  ```
  POST /prompt 200
  ClaudeCLIStreamWorker: launching claude … -p --resume <sid>
  Spawning PTY (… --resume <sid> …)
  POST /open 200          ← no 409 anywhere
  ```

  Two workers on one transcript. The turn's answer never lands; the session ends
  `worker_status: api_timeout` with a `user_message` and no `assistant_message`
  after it. This happened **while the strict client-side readiness gate was
  live** — `busy` reaches the client as a WS snapshot, so a click in the same
  beat as the send reads a stale `false`. A client gate closes the slow case
  (clicking a minute into a turn) and is useless against the race that actually
  corrupts the transcript. The fix is the guard on `open`
  (FLOWPAD-2117); until it lands, `→terminal` is unguarded on both sides by
  design, and the fixture says so.

* **Reproduces 100% on prod** (v0.2.140, confirmed on unpatched `:9007`). It is
  not a dev-instance artifact and not timing-dependent.

* **Asymmetric safety net.** `SimpleChatPane` mounts both `useObservedTurn` and
  `useTurnCompletionReconcile`; `EntityExecutionPanel` (vibe) mounts only the
  former. A dropped observation self-heals at turn end in chat and never heals
  in vibe.

* **Not proven — adjacent suspicion.** `observe-turn` watermarks at open with
  `emitted = len(entries)` (`flow_sdk/builtin/agentic_process/agentic_process.py:4395`)
  on the stated premise that "the caller's pane loads history on mount, so
  everything up to now is already on screen". This RCA disproves that premise.
  Whether the watermark therefore drops rows the pane never had is a hypothesis
  with **no on/off lever yet** — do not treat it as a rule.
