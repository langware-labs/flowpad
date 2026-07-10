---
id: 6e577cb3-7a75-40fc-bc7c-7a70bdc58ea6
---

# Codex Chat / Terminal Full E2E Matrix

Run every test serially through DebugMCP Chromium against a dedicated named
instance. Before each test, obtain the exclusive instance lock, run a full
`flow instance reset <name> --json`, require `ready=true`, navigate to the
instance frontend, and verify bootstrap contains `types`. Never reuse database,
process, transcript, browser storage, or test-owned asset state from another
test. Use unique markers and remove test-owned global Codex skills in teardown.

The canonical Codex transcript is the durable-data oracle. Compare durable
semantic entries by role, order, entry/tool identity, error state, and usage;
do not deduplicate by content. Transport-only status/progress frames may differ.

test 1: D01 P0 exhaustive deterministic FlowData projection
- seed a deterministic Codex rollout containing user, assistant, developer,
  reasoning, successful and failing commands, function/custom tools, multi-file
  changes, skill read, usage, error, result, and end entries
- open the process in chat, switch to terminal and back, then hard reload
- validate canonical transcript, history, frontend FlowData, and rendered chat
  retain every durable semantic entry exactly once and preserve tool pairing

test 2: D02 P0 live headless semantic parity
- create a headless Codex process and submit a unique-marker task that performs
  one successful command, one failing command, and a multi-file edit
- validate HTTP/WS output, full transcript, history, and rendered chat agree on
  message order, tool pairing, failure metadata, usage, result, and end

test 3: D03 P0 live PTY semantic parity
- create an interactive Codex process and run the D02 task from the chat skin
  over PTY, then expose the raw terminal
- validate terminal-visible output and every structured durable entry agree,
  with no missing or duplicated entry after switch and reload

test 4: D04 P0 identical-content preservation
- send the exact same prompt three times while alternating headless and PTY
- run the same shell command twice with identical output
- validate three user turns, three assistant turns, and both tool call/result
  pairs remain in canonical transcript, forced history, stream, and rendered UI

test 5: D05 P0 post-switch forced-history race
- seed at least 1,000 mixed history entries, switch mode, and immediately submit
  a delayed BEGIN/tool/END turn while forced history reconciliation is active
- validate no old or new entry disappears or duplicates, the pane never blanks,
  and the final stream projection equals the canonical transcript

test 6: D06 P0 reload and disconnect mid-turn
- in each transport, start a BEGIN/delayed-tool/END turn and hard reload after
  BEGIN but before the tool completes
- validate the same process/session continues and the remounted UI automatically
  converges to user, BEGIN, tool, and END exactly once without manual repair

test 7: D07 P0 all stream access paths
- execute equivalent unique-marker turns through the browser HTTP prompt path
  and watched WebSocket submit path
- compare prompt output, output iterator, step, getOutputs, forced history,
  process transcript, generic transcript endpoint, and rendered UI
- validate no replay-to-subscribe gap, no HTTP/WS duplicate, correct source tags,
  and completion only after final content

test 8: D08 P1 concurrent process and watcher isolation
- create four Codex processes with unique markers and overlapping tool IDs, with
  two independent browser contexts/watchers observing each process
- validate no marker, parser state, result pairing, or watcher route crosses a
  process boundary; reload every client and revalidate canonical parity

test 9: D09 P1 cancel and error durability
- cancel a turn after a tool starts, then execute a deterministic nonzero command
- validate busy clears, exactly one final outcome is recorded, partial assistant
  text is not duplicated, error metadata survives switch/reload, and next turn works

test 10: D10 P1 large-history switch/reconnect stress
- materialize at least 1,000 mixed entries and perform ten switch, reload, and
  reconnect cycles with a fresh live marker after every cycle
- validate exact counts/order, responsive controls, batched rendering, no missing
  tool/reasoning rows, and no duplicate-key or nested-update console errors

test 11: R01 P0 supported Codex flag change and revert
- start an advanced Codex terminal and record session, worker identity, snapshot,
  command, and restart-info
- change model, permission mode, and environment; validate exact persisted diff,
  restart glow, and unchanged live worker, then revert and require a clean diff

test 12: R02 P0 multi-flag restart apply
- drift model, permission, and environment together, then click Restart once
- validate exactly one worker replacement, same process/session/transcript,
  effective Codex command contains all changes, and restart state becomes clean

test 13: R03 P0 no phantom restart from mode switching
- perform terminal to chat to one real headless turn to terminal ten times
- at every settled point validate restart_required=false, empty user-config diff,
  no amber flicker, one session, and no duplicate worker

test 14: R04 P0 pending config consumed across modes
- drift terminal config, switch to chat instead of restarting, and run a turn
- validate the headless invocation uses current config without a restart prompt;
  change it again headless, return to PTY, and validate the new snapshot is clean

test 15: R05 P0 restart preserves transport
- restart once while terminal is active and once while headless chat is active
- validate terminal remains PTY and chat remains headless, or that unsupported
  headless restart is disabled; session, transcript, and configuration survive

test 16: R06 P0 real UI busy guards
- during a long turn in each transport, attempt toggle and restart by pointer,
  keyboard, repeated activation, and direct switch/restart endpoints
- validate UI actions issue no teardown, endpoints return 409, the turn completes
  once, controls re-enable, and one post-turn restart succeeds

test 17: R07 P1 failed restart and failed switch retention
- create pending drift and force an isolated deterministic Codex launch failure
- validate error visibility, spinner cleanup, retained config/snapshot/restart flag,
  usable prior surface, no duplicate PTY, and one successful retry

test 18: R08 P1 config-write race with restart and switch
- for twenty iterations save config A, begin restart or switch, then race config B
- validate B is never lost and final state is either captured-and-clean or
  newer-and-pending; never clean-with-diff, two workers, or session drift

test 19: R09 P1 Codex-specific controls and command rendering
- open CLI Options and Session Info for Codex in both transports
- validate unsupported Claude Chrome/Debug controls are absent or inert, Full
  Trust maps to the Codex bypass flag, and displayed commands begin with codex

test 20: A01 P0 skill use across Chat and Terminal
- attach a uniquely named marker skill, invoke it once in each mode, and reload
- validate one durable ref, correct descriptor rows, exactly two normalized skill
  calls, Skills panel count x2, used state, and no duplicate transcript entries

test 21: A02 P0 attach skill while PTY is running
- record worker and restart snapshot, then attach a marker skill
- validate exact asset/add-dir restart diff and glow; restart once, require a new
  worker and clean snapshot, then use the skill in both transports

test 22: A03 P0 embedded agent persona lifecycle
- attach a strict marker persona and validate it after a fresh entity load,
  hard reload, mode round-trip, and restart
- detach it, apply the required restart, and validate generated instructions and
  subsequent responses contain no stale persona marker

test 23: A04 P0 same-name Codex skill process isolation
- create two processes with different skill bodies under the same skill name
- alternate five invocations and mode switches; attach, restart, and detach A
- validate each process always uses its own body and B is never changed by A

test 24: A05 P0 Flowpad Assistant toggle on Codex
- toggle Assistant off then on for a running Codex PTY, validate exact add-dir
  restart diff, restart, and invoke a bundled skill in each transport
- disable and restart; validate it is undiscoverable and leaves no stale global copy

test 25: A06 P1 project, context, and additional-directory parity
- mount overlapping fixture roots containing sentinels, skills, and agents
- validate canonical deduplication and longest-prefix source attribution; both
  transports access the same intended assets, and removal reverses the diff

test 26: A07 P1 Codex MCP configuration lifecycle
- configure a fixture MCP tool with a unique marker and invoke it in each mode
- modify its config and validate documented restart behavior, exactly paired
  call/results after reload, and separation between MCP and process assets

test 27: A08 P1 attachment-path churn and recovery
- exercise both attachment APIs with twenty rapid attach/detach operations,
  duplicate requests, a missing source, and a broken symlink
- validate references, files, descriptors, generated instructions, and restart
  diffs converge exactly; recovery is visible and detach remains idempotent
