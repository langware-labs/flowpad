# Prompt Queue

Backend-owned FIFO of pending prompts per `AgenticProcess`, with a zero-logic
frontend. One source of truth — a JSON file in the process's record folder —
reflected to the UI through the entity, mutated only through entity actions,
and drained exclusively by the backend.

Design principles:

- **The backend owns the queue.** The file, the drain decision, and the
  injection all live in `flow_sdk`. The frontend never injects, never polls,
  and holds no queue state.
- **The frontend reflects and requests.** It reads the entity's reflected
  `queue` field (pushed live over `data_op`) and mutates via four HTTP
  actions. The only client-side state is the add-box draft text.
- **Launch rides the queue.** "Open in Claude"-style launches put the first
  prompt ON the queue; the worker boots *with* it as its launch argument —
  deterministic, no post-spawn stdin race (the original "lost first prompt"
  bug).

## On-disk format

Two files next to each other in the process record folder
(`…/records/agentic_process/agentic_process-@<id>/`):

`prompt_queue.json` — current state. Atomic writes (temp + `os.replace`);
reads never raise (missing/corrupt → default `{"enabled": true, "entries": []}`).

```json
{
  "enabled": true,
  "entries": [
    { "id": "…hex…", "prompt": "…", "source": "ui", "created_at": "…iso…" }
  ]
}
```

`prompt_queue_log.jsonl` — append-only debug log, one JSON object per line:
`{ts, action, source, …payload}`. Actions: `enqueue`, `dequeue`, `clear`,
`set_enabled`, `drain_check` (with `reason`), `pop`, `inject`, `injected`,
`error`. Sources: `ui`, `launch`, `enqueue`, `enable`, `ready`,
`launch-requeue`. This log is the audit trail — read it first when debugging.

## Components and interfaces

```
PromptQueue   flow_sdk/builtin/agentic_process/prompt_queue/   pure file lib,
              read/enqueue/pop/dequeue/clear/set_enabled/log   no AP knowledge

AgenticProcess (python)                    AgenticProcess (ts_sdk)
  .queue -> PromptQueue(record_dir/...)      queue: QueueState | null   (reflected, read-only)
  HTTP actions:                              thin wrappers:
    POST .../enqueue {prompt, source}          enqueue(prompt, source='ui')
    POST .../dequeue {id | index}              dequeue(idOrIndex)
    POST .../clear-queue                       clearQueue()
    POST .../set-queue-enabled {enabled}       setQueueEnabled(bool)
  createProcess accepts launch_prompt        openTab(...) passes launchPrompt
  serializer: data["queue"] = queue.read()   (rides every to_dict / data_op)

QueuePanel.tsx (side-windows)              declarative: reads the entity queue
                                           via useEntity, calls the wrappers
```

Wire shape (`QueueState` / `QueueEntry` in `ts_sdk/src/process/agentic-process.ts`)
is identical to the file shape — flat `entry.prompt`, no nesting.

## Data flows

### Launch (first prompt boots the worker)

```
openTab(type, prompt) -> POST createProcess {..., launch_prompt}
    1. save entity
    2. queue.enqueue(launch_prompt)      <- seeded BEFORE the auto-start
    3. visible: start_pty()
         _perform_open(instruction=None), fresh-spawn branch:
            queue enabled + non-empty -> pop head (under the queue lock)
            instruction = head.prompt
         claude boots WITH the prompt as its LAUNCH ARG
    log: enqueue -> pop -> inject -> injected   (source=launch)

dock navigation -> loader process.start() -> reattach (idempotent; queue empty)
```

Seeding inside `createProcess` — before its `visible` auto-start — is what
makes this race-free. A post-create enqueue would land after the worker
already booted empty. If the boot fails, the popped head is re-enqueued
(`_requeue_failed_launch`, source `launch-requeue`) so the prompt isn't lost.

### Follow-up drain (prompt added while the agent works or idles)

```
triggers (each -> _schedule_queue_drain(source), fire-and-forget):
  "enqueue"  POST enqueue action
  "enable"   POST set-queue-enabled {true}
  "ready"    _flush_transcript_change ready-edge: worker transitions into
             IDLE / COMPLETE / INTERRUPTED

_maybe_drain_queue(source):              [serialized by _QUEUE_LOCKS[id]]
  empty or disabled        -> log drain_check(empty_or_disabled), stop
  resolved = fetch_worker_status()   ONE tail-read (only when status==RUNNING),
             shared by the gate and the not-ready log line
  _queue_ready(resolved)?  -> no: log drain_check(not_ready), stop
  pop head                 (persists removal BEFORE injecting)
  log inject, notify_updated, release lock
  prompt(head)             -> stdin (live PTY) or a new headless turn
  log injected | error
```

### Reflection (how the UI stays live)

```
any queue mutation -> notify_updated() -> serializer embeds queue.read()
  -> WS data_op UPDATE { ..., queue: {enabled, entries} }
  -> castAndDeepAssign:
       onEntityUpdate: this.queue = REPLACE(wire.queue); delete wire.queue
       deepAssign(rest)         <- merges arrays BY INDEX, never shrinks;
                                   without the strip, [A,B] + wire [B]
                                   would corrupt to [B,B]
  -> useEntity subscribers re-render -> QueuePanel reads the fresh queue
```

Two frontend gotchas this flow encodes:

1. `deepAssign` index-merges arrays — any reflected array field that can
   shrink must be replaced wholesale in `onEntityUpdate` AND stripped from
   the payload (the hook runs before `deepAssign`). Same guard the cache
   path uses for `state`.
2. `InteractiveTerminal`'s `process` is a loader-context stable ref —
   in-place `data_op` mutations never re-render it. The panel subscribes
   itself: `useEntity(process.typeId)`.

## Readiness — the `_queue_ready` decision

The live worker status is read via **`process.fetch_worker_status()`** — the
public accessor over the transcript-tail projection
(`_discover_status_from_transcript` is internal; don't call it directly).
Each call is a tail-read, so resolve once and pass the value along.

`is_ready_for_input` (truth-tabled: RUNNING and worker in
{IDLE, COMPLETE, INTERRUPTED}) is intentionally untouched; the drain's gate
is a superset:

| ProcessStatus | worker (transcript tail) | visible (PTY) | headless | rationale |
|---|---|---|---|---|
| RUNNING | IDLE / COMPLETE / INTERRUPTED | inject (stdin) | inject (new turn) | settled post-turn |
| RUNNING | PENDING_USER | inject | inject | idle at its prompt — exactly when a follow-up belongs |
| RUNNING | WAITING / THINKING / TOOL_* / API_ERROR / INITIALIZING | wait | wait | mid-turn; the next ready-edge retries |
| RUNNING | None (no transcript yet) | wait | wait | just booted; ready-edge will fire |
| NEW / STOPPED / FAILED | — | **never cold-start** | cold-start | a visible PTY boots only through `_perform_open` so the head rides the launch arg; a drain cold-start would race the dock loader into an empty boot |
| STARTING / STOPPING | — | wait | wait | boot/teardown in flight |

Single-booter invariant: for a visible PTY the loader's `start()` /
`_perform_open` is the only cold booter (and the only launch-arg consumer);
for headless the drain is the only cold booter. Two booters per mode is how
the lost-first-prompt race happened.

Known parked edge: a queued prompt on a RUNNING worker that has aged to
INACTIVE stays pending until the next trigger (a new enqueue/enable, or a
restart — where the launch path consumes it).

## Entry lifecycle

```
(none) --enqueue--> PENDING --pop--> POPPED --inject ok--> INJECTED
                      |                |--launch boot failed--> PENDING (launch-requeue)
                      |--dequeue/clear--> REMOVED
disabled flag freezes PENDING entries (drains no-op); re-enable drains.
```

## Concurrency

- `_QUEUE_LOCKS[process_id]` — serializes every read-check-pop, including the
  launch-path consume in `_perform_open`. Released before `prompt()` (slow,
  itself serialized by the prompt/open locks).
- `_OPEN_LOCKS` — serializes boots; a second `start_pty` reattaches and finds
  the queue already drained.
- Pop-persist-first: the head is removed on disk before injection, so a
  re-fired ready edge can never double-inject.

## Testing

- `tests/unit/test_prompt_queue.py` — pure-file PromptQueue (FIFO, atomic
  writes, corrupt-file tolerance, log).
- `tests/long_tests/test_prompt_queue_integration.py` — real worker,
  parametrized: `pty` drives `start_pty()` (launch-arg consume), `headless`
  drives the drain. Run as:

  ```bash
  DEEP_TESTING=1 FLOWPAD_CLAUDE_HOME="$HOME/.claude" \
    uv run pytest tests/long_tests/test_prompt_queue_integration.py -v
  ```

  `FLOWPAD_CLAUDE_HOME` is required: the conftest swaps `HOME` to real for
  CLI auth, but in-process `claude_projects_dir` stays sandboxed without it —
  transcript discovery then misses the real session file and the test
  downgrades to a SKIP that masquerades as an API issue.
- `ui/tests/unit/queue-zero-logic.test.ts` — source-contract test pinning the
  zero-logic frontend (entity-reflected reads, action-only mutation, no
  client injection, `openTab` uses `launchPrompt` not `execute`).

## Debugging checklist

1. `cat <record_dir>/prompt_queue.json` — what is pending, is it enabled?
2. `cat <record_dir>/prompt_queue_log.jsonl` — full event history; the
   expected happy paths are
   `enqueue -> pop -> inject -> injected` (source `launch`) and
   `enqueue -> drain_check(ok) -> pop -> inject -> injected` (source
   `enqueue`/`ready`).
3. `drain_check` with `reason=not_ready` records the `status` and
   `worker_status` the gate saw — compare against the readiness table above.
4. UI stale but the file is right? Check the reflection gotchas (deepAssign
   strip, `useEntity` subscription) before suspecting the backend.
