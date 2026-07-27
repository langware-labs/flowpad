---
id: c25307a6-6647-4bba-85f4-8651c1029806
---

# Codex Chat / Terminal Switch Base Matrix

Run serially through DebugMCP Chromium. Before every test, allocate a fresh
cycle-owned Codex/Claude home, reset the dedicated Flowpad instance, require a
valid bootstrap, open a fresh browser tab, and clear browser storage.

test 1: C01 Standard new Codex starts as headless chat
- set Standard view and create Codex from the Chats navigator
- validate chat pane, pty_mode=false, usable composer, Codex identity, and no xterm

test 2: C02 Advanced new Codex starts as interactive terminal
- set Advanced view and create Codex from the Chats navigator
- validate pty_mode=true, xterm and process toolbar, Codex identity, and toggle

test 3: C03 Standard Quick Create is chat skin over PTY
- set Standard view and create Codex through Quick Create
- validate chat UI is active while durable pty_mode=true and a live PTY exists

test 4: C04 headless chat switches to terminal
- create Standard headless Codex and click the real pointer toggle
- validate switching state, interactive transport, xterm mount, stable process/session

test 5: C05 terminal switches to headless chat
- create Advanced interactive Codex and click the real pointer toggle
- validate terminal teardown, headless transport, chat mount, stable process/session

test 6: C06 prompt succeeds in both transports
- submit a unique marker in chat, switch with the real toggle, and submit another
- validate one assistant response for each marker and controls return to idle

test 7: C07 cross-mode transcript and session continuity
- run two turns per transport while alternating modes
- validate one session ID, ordered four-turn transcript, and no duplicate messages

test 8: C08 switch is blocked during an active turn
- start a delayed Codex task and attempt the real toggle by pointer and keyboard
- validate the control is disabled, no mode request is sent, and turn completes once

test 9: C09 switch before the first Codex turn
- create Codex without a launch prompt and switch modes before sending anything
- validate the destination becomes ready and the first turn creates one valid session

test 10: C10 hard reload preserves selected mode and transcript
- run a marker turn, switch mode, call real page.reload(), and wait for reattachment
- validate transport, UI skin, process/session, transcript, and next-turn usability

test 11: C11 ten real pointer round trips
- perform ten alternating real pointer toggle clicks with one marker turn per mode
- validate exact skin/transport agreement, stable session, idle status, and all markers

test 12: C12 view preference and explicit chat override
- exercise Standard, Advanced, and Dev view modes with chat/terminal overrides
- validate null override follows view default and explicit override remains authoritative

test 13: C13 two Codex tabs remain independent
- create one headless and one interactive Codex process and alternate their tabs
- validate each tab retains its own mode, session, transcript, toggle state, and focus

test 14: C14 restored Codex session switches both ways
- create a transcript, reset only the browser connection, restore the process tab,
  and switch both directions
- validate restored history, session identity, and one new turn in each mode

test 15: C15 mode-switch failure recovery
- force one deterministic switch/start failure
- validate visible error, switching spinner cleanup, prior usable surface, consistent
  pty_mode/skin, and one successful retry without a duplicate worker

test 16: C16 accessibility and Codex-specific chrome
- validate the real toggle's accessible name, disabled reason, focus, and state attrs
- validate Codex branding and supported controls without Claude-only labels or commands
