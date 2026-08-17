---
id: 1c50ac47-04dd-5c44-9382-17b0b2a4c2e3
---

# Manual Regression: Terminal Self-Resumes After Sleep/Wake

## What this guards

After the machine **sleeps and wakes** (or the network drops and returns), an open
terminal must keep streaming on its own — **no page refresh**. The bug this guards
against (regressed by commit `c81f3176`, 2026-05-04; fixed by the backend-owned
membership FSM): on wake the app WebSocket reconnects and the shell keeps producing
output, but the terminal stays **frozen on its pre-sleep frame** because the
reconnected connection was never re-added to the PTY's subscriber set. Input still
worked, output was dead, until a manual refresh.

The fix made connection membership backend-owned and symmetric:
`PtyRegistry.on_ws_disconnect` **parks** the connection (ATTACHED → DETACHED) and
`PtyRegistry.on_ws_connect` **resumes** it (DETACHED → ATTACHED) on the same
`connection_id` — see `flow_sdk/server/routes/websocket.py` +
`flow_sdk/compute/providers/desktop/pty_session_manager.py`, and
`docs/agent-management/pty-websocket.md`.

## Why physical sleep remains manual

- It needs a **real OS sleep/wake** (or a real network sever). A `SIGSTOP`/`SIGCONT`
  of the backend does **not** reproduce it — on loopback the kernel keeps the socket
  alive, so it self-heals. Browser offline/online emulation verifies the functional
  reconnect contract in the automated `.md.ts`, but it cannot prove the OS-level
  `close 1006` transport signature.
- It must run against a **Vite-free, prod-style build**. The Vite dev server
  (`npm run dev`) force-reloads the page when its HMR socket reconnects on wake —
  that full reload *is* the "refresh cure" and **masks the bug**. Use a built UI
  served statically instead.
- The automated oracle deliberately avoids coupling to the page-level `WebSocket`
  constructor. HMR and runtime wrappers can replace that constructor without
  changing whether the terminal actually resumes.

## Setup (prod-style, no Vite)

1. Start a backend from this checkout (e.g. `scripts/instance_ctl.sh launch dev-1`
   → backend `:6001`), or any instance running the code under test.
2. Build the UI pointed at that backend and serve it **without HMR**:
   ```bash
   cd ui
   VITE_API_URL=http://localhost:6001 npm run build
   node_modules/.bin/vite preview --port 4173 --strictPort --host 127.0.0.1
   ```
   `vite preview` is a static file server (no HMR), so it will **not** auto-reload on
   wake. (Do **not** use `npm run dev` for this test.)
3. Open `http://127.0.0.1:4173/` — confirm the app socket connects to the backend
   (`ws://localhost:6001/api/v1/connect/ws/<connection_id>`).

## Manual steps

1. Open a terminal (`>_` nav icon, or `/dock/shell/`).
2. Start a 1 Hz stream so a freeze is obvious:
   ```sh
   while true; do printf 'beat-%s\n' "$(date +%H:%M:%S)"; sleep 1; done
   ```
3. Note the last `beat-` line, then **sleep the Mac** (`pmset sleepnow`, close the
   lid, or  menu → Sleep).
4. Wait ~1–2 minutes, then **wake** it.
5. **Expected (PASS):** within a couple seconds the terminal **resumes on its own** —
   `beat-` lines advance to the current time, gap-free going forward — with **no
   page refresh**. The tab stays at the same URL; you did not reload.
6. **Fail (the regression):** the terminal stays frozen on the pre-sleep `beat-`
   line; only a manual refresh brings it back.

## Expected backend/transport signature (for debugMCP runs)

Instrument the app WebSocket and you should see, across the wake:
- `close` with `code: 1006, wasClean: false` on the old socket, then `construct` +
  `open` of a new socket with the **same** `connection_id`.
- Backend log: `[PtyRegistry] Resumed connection <id> on <pty_key>` (from
  `on_ws_connect`). Before that, on sleep: `[PtyRegistry] Parked connection <id> …`.
- The server-side `.pty` stream file keeps growing during the freeze (shell never
  died); the terminal DOM line advances after wake (renderer painted resumed output).

## Automated drive via debugMCP + `pmset` (optional)

The whole loop can run hands-free — sleep AND auto-wake — without a manual lid tap:

1. **Auto-wake requires `sudo`.** Programming the RTC wake alarm
   (`pmset schedule wake "<time>"`) is root-only; `pmset sleepnow` is not. To let an
   agent drive it non-interactively, add a one-line passwordless-sudo drop-in for
   **only** pmset:
   ```bash
   echo "$(whoami) ALL=(root) NOPASSWD: /usr/bin/pmset" | sudo tee /etc/sudoers.d/pmset-nopasswd
   sudo chmod 440 /etc/sudoers.d/pmset-nopasswd
   # verify: sudo -n pmset -g sched   # should not prompt
   # revoke later: sudo rm /etc/sudoers.d/pmset-nopasswd
   ```
   Without this, set the wake manually (`! sudo pmset schedule wake "<time>"`) or
   wake by hand.
2. Before sleeping: in the page, record the last terminal line + WS `readyState` +
   an inbound-message counter (a 1 Hz `setInterval` recorder survives the freeze;
   the CDP connection itself drops on sleep — reconnect to the tab afterward).
3. Arm the wake, sleep, and wait past the alarm in **one background command** so the
   agent is notified on resume:
   ```bash
   WAKE_AT="$(date -v+6S '+%m/%d/%Y %H:%M:%S')"   # +6s; see floor below
   sudo -n pmset schedule wake "$WAKE_AT"
   pmset sleepnow
   TARGET=$(date -j -f '%m/%d/%Y %H:%M:%S' "$WAKE_AT" '+%s')
   while [ "$(date +%s)" -lt $((TARGET+6)) ]; do sleep 1; done
   echo "RESUMED at $(date '+%H:%M:%S')"
   ```
4. On resume, reconnect to the tab and assert `last_line != pre_sleep_line` (the
   terminal self-advanced) and that a `close 1006 → open` pair was logged.

### Auto-wake notes (verified 2026-06-09)

- Cycle floor: tested **3s and 6s** wake leads — both sleep-then-auto-wake reliably.
  ~3s is the practical minimum (sleep entry is ~1–2s); below that the alarm can fire
  before the Mac is asleep and get missed, leaving it stuck (then a key-tap is
  needed). Use ~6s for margin, ~3s when iterating fast.
- A wake lead this short still produces a real `close 1006` → reconnect, so it
  exercises the fix — you do not need minutes of sleep.
- Even with `NOPASSWD`, the CDP/browser-automation channel drops on sleep; always
  re-list/re-select the tab after wake before reading the in-page trace.
- Scheduled wakes can be "dark wakes" (display off, may re-sleep) — fine here,
  because the WS reconnect still fires; just keep the post-wake read prompt.

## Pass criteria

- Terminal advances past its pre-sleep frame **without any refresh**.
- The original terminal remains selected and its URL is unchanged.
- Closing a tab (the `×` button) still destroys the session — disconnect (park) and
  close (destroy) remain distinct.
- For a physical sleep/wake diagnostic run, WS `close 1006` → reconnect with the
  same `connection_id` and backend park → resume logs are supporting evidence, not
  the automated test oracle.
