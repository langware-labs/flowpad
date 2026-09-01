---
id: eb30bc0e-517c-4aea-8381-4f0c9cf42ed1
title: Surface change must reconcile the transcript
tags:
- breadcrumb.test.surface_transcript_reconcile.rules
description: A turn produced on the surface you are LEAVING has no route into the
  incoming pane — terminal to vibe must force a history reload, because the mount-time
  loadHistory() no-ops on a latch nothing ever resets.
---

# Surface change must reconcile the transcript

> Ground truth. Proven by RCA on 2026-08-20. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.surface_transcript_reconcile.rules
sites:
  - rel_path: "ui/tests/react/process-surface-startup-reconcile.test.tsx"
    line: 55
    note: "EDITING use-process-surface? the non-PTY branch MUST force loadHistory - read this tag's rules first; this file stubs loadHistory and does NOT cover it"
```

## Expected behavior

Switching the footer `ViewToggle` between Terminal and Vibe/Chat is **navigation**
(`?viewMode=`). The one thing navigation cannot express is the transport, so
`useProcessSurface` reconciles it. Two separate obligations hang off that
transition, and only the first is about workers:

1. **Transport** — a terminal surface requires a live PTY; chat and vibe require
   nothing, because they render `flowDataStream`, which is transport-independent.
   Reconciliation stays one-directional here: never kill a healthy worker to
   enter chat.
2. **Content** — the incoming pane must end up showing everything the backend
   already has, *including the turns the outgoing surface produced*. This
   obligation is symmetric. It applies in both directions, and it is the half
   that was missing.

After `terminal → vibe`, a turn typed into the xterm must appear in the vibe
pane without a page reload.

## Internals

* **`useProcessSurface`** (`ui/src/components/terminal/interactive-terminal/use-process-surface.ts`)
  is the only production caller of `switchMode`, at `:150` — and it only ever
  passes `WorkerMode.Interactive`. The `cli` direction of the backend
  `switch-mode` action is unreachable from the UI.

* The non-PTY branch is at `:118`. Before the fix it early-returned outright;
  the `loadHistory({ force: true })` reconcile existed only on the PTY branch
  (`:158`), i.e. only on `vibe → terminal`.

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

* `pty_mode` is itself a one-way latch — it goes `false → true` on
  `vibe → terminal` and **nothing in `ui/src` ever writes it back**, not even a
  page reload. Any rule you write about the vibe pane must hold with `pty_mode`
  still true.

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

## Invariants

* **A surface change reconciles content in BOTH directions.** Transport is
  one-directional; the transcript reconcile is not. Adding a branch to
  `useProcessSurface` that returns without either switching transport or
  reloading history reintroduces this bug.

* **Force-reload only at idle.** `loadHistory({ force: true })` REPLACES the
  stream with the on-disk transcript, so a frame not yet persisted is dropped.
  Guard on `isReadyForInput` (`awaitingUserInput`, `:85`) — this is
  `loadHistory`'s documented force-path contract, not a local preference.

* **Leave the mode unrecorded when you decline mid-turn.** Not writing
  `lastReconciledMode` is what makes the effect retry the moment the worker goes
  idle; recording it strands the session unreconciled. Both guarded branches
  (`:125` and `:143`) depend on this.

* **Never treat a mount-time `loadHistory()` as a repair.** It is unforced, so
  it is a no-op on any process this page load has already loaded. If a pane
  needs to converge with disk, it must force, or use a hook that does
  (`useTurnCompletionReconcile`).

* **Never kill a worker to enter chat or vibe.** `bf9b5170` removed that path
  for cause — it killed healthy PTYs on a view change and silently queued the
  kill when the backend refused mid-turn (409). The fix above restores the
  *content* obligation without restoring the transport one.

## Failure modes

* **The frozen pane.** After `terminal → vibe` the pane shows the last
  pre-switch message and nothing after it. Measured: backend `get-history` 85
  items, client `flowDataStream` 69. A full page reload fixes it, which is the
  tell — a reload constructs a fresh `AgenticProcess` with `_historyLoaded`
  false, so the unforced mount load actually runs.

* **`terminal → vibe` fires zero transport requests.** Only a tab-activate and a
  prefs write. If you are looking at a network log for the bug, there is nothing
  to see; the defect is an absence.

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
