# ContextProcess

> **ContextProcess is not a real entity.** It is the pairing of two existing
> entities — a **`GraphContext`** (the *context*) and an **`AgenticProcess`**
> (the *process*) — plus a small, uniform mechanism for capturing context,
> binding it to a process, and folding it into the process's system prompt at
> launch. "ContextProcess" is the *name of the pattern*, not a type you can
> `get_one` for.

```
ContextProcess  ≡  ( GraphContext , AgenticProcess )
                    └── context ──┘  └── process ──┘
```

An **automation** has always been "a prompt + a context, run as a process"
(see `flow_sdk/builtin/graph_context.py`). ContextProcess makes that pairing
explicit and uniform across *every* surface that launches a worker.

---

## 1. Why

The same shape — *a process running in some context* — recurs across the app:

| Surface            | Context it runs in                                   |
| ------------------ | ---------------------------------------------------- |
| Assistance chat    | project + active entity                              |
| Conversation       | project + active entity + **conversation**           |
| Message            | project + active entity + conversation + **message** |
| flow_diagnose      | (none — fresh cwd)                                    |
| Run Automation     | a *frozen* `GraphContext` chosen by the user         |

Each surface re-derived its context ad hoc (`target_typeid_str` here, a
`shared_context_entities` link there, nothing for diagnose). ContextProcess
unifies them: **every launch captures a `GraphContext` and binds it to the
process.** The context is then available for two things:

1. **System prompt** — the worker is told, at creation time, what it is
   working on.
2. **The grid** — "do we already have a process in this context? what was the
   last one?" — a reverse index of *context entity → processes*.

---

## 2. The four moving parts

### 2.1 `captureContext()` → `GraphContext`  *(frontend)*

Builds a `GraphContext` object from the live `DataContext` slots
(`ContextEntitiesEnum`). This already exists as the "Open Context" freeze
(`ui/src/tabs/useTerminalStripController.tsx:215`); ContextProcess generalizes
it so any launcher can call it.

* `project_id` and the **active entity id** are included **by default**.
* The conversation surface **adds** the conversation id.
* The message surface **adds** the message id (on top of conversation).
* Context need **not** be complete — a partial set is valid. The UI owns which
  keys go in; the backend treats the set as opaque.

The result is a `GraphContext` with `context_typeids: string[]` (the source of
truth) and `slot_map: {slotName → typeid}` (for labeling).

### 2.2 `agenticProcess.setGraphContext(ctx)`  *(binding)*

Binds a captured context to a process **before launch**.

* Stores the `GraphContext` id on the process (`context_data["graph_context_id"]`).
* **Mirrors** `ctx.context_typeids` onto the process's existing
  `shared_context_entities` — the already-queryable relationship list. We do
  **not** add a second parallel context list (that would drift).
* **Pre-launch only.** Once `session_id` exists, `project_id`/`workdir` are
  frozen (`_BINDING_FROZEN_FIELDS`), and the transcript is keyed to them.
  `setGraphContext` after a session exists is a programming error — it raises,
  it does not silently re-stamp.

### 2.3 `GraphContext.summary()` → system-prompt addition  *(backend utility)*

Pure-backend. Resolves each `context_typeid` to a readable line and returns a
block of the form:

```
At creation time, the context entities are:
- Project: flowpad-oss
- Conversation: "Design review with Bob"
- Message: "can you take a look at the navigator?"
```

* Frontend obtains it (when needed for display) via a backend `summary` action
  on `graph_context`; it never builds the summary itself.
* The phrasing is deliberately **past/anchored** ("At creation time …") because
  the context is **frozen** — it describes the world as it was when the process
  was launched, and never changes for the life of the process.

### 2.4 Injection at launch  *(backend, system-prompt management)*

`AgenticProcess` owns its system prompt additions in one place. At launch, if
the process has a bound `GraphContext`, its `summary()` is appended to the
process's system-prompt additions, which flow through the **existing**
`context.instructions` channel:

* **Headless / print-mode** (conversation, message, diagnose): `instructions`
  is set on the `_AgenticContext` built at `agentic_process.py:2064`; the Claude
  worker maps it to `system_prompt.append` (`code_agentic_worker.py:234`).
* **PTY / interactive**: the same additions are passed via the CLI driver's
  `--append-system-prompt` channel.

Both paths read from a single `AgenticProcess._system_prompt_additions()` so the
two never diverge. This is the "manage the system prompt properly" requirement:
context summary, AMD instructions, and assistant directives all compose through
one accumulator rather than being spliced in ad hoc per call site.

---

## 3. Resume vs. new is unchanged

ContextProcess does **not** touch the resume machinery. The decision stays where
it is:

* **Caller layer** — "is there already a process for this context?" — now
  answered uniformly via the `GraphContext` (see §4) instead of per-surface
  bespoke lookups.
* **Driver layer** — `has_resumable_session(process)` — unchanged: resume iff a
  real on-disk transcript exists for `session_id`.

Because the summary is frozen at creation and lives in the system prompt that
was recorded with the transcript, **resuming a context-process replays the
original context** — exactly what we want.

---

## 4. The grid: "processes in this context"

The grid is a reverse index built on the **existing** `shared_context_entities`
column (which §2.2 mirrors the context onto):

```
processesInContext(typeid)      → AgenticProcess[]   ordered by recency
lastProcessInContext(typeid)    → AgenticProcess | null
```

* "Do we already have a process in this context?" → `processesInContext(key)` non-empty.
* "What was the last one?" → `lastProcessInContext(key)` (most-recent wins, the
  existing `mostRecentProcess` recency rule).
* The UI can render an **entities × processes** grid: for each context entity
  (project, conversation, message, …), the processes bound to it.

This generalizes today's `useProcessesForTarget` (which keys on a single
`target_typeid_str`) to a *set* of context entities. `target_typeid_str` remains
as the primary/first element for back-compat.

---

## 5. Surfaces as instances of one pattern

| Surface         | Capture adds        | Binds GraphContext | Reuse key (grid)            |
| --------------- | ------------------- | ------------------ | --------------------------- |
| Assistance chat | (defaults only)     | yes                | active entity               |
| Conversation    | conversation id     | yes                | conversation id             |
| Message         | conversation + msg  | yes                | message id                  |
| flow_diagnose   | (empty context)     | no-op (empty)      | — (always new)              |
| Run Automation  | user-chosen frozen  | yes (explicit)     | the GraphContext itself     |

`flow_diagnose` is the degenerate case: empty context → no summary, no reuse,
always new. It validates the model rather than being a special case in it.

Everything else about a process — queueing, PTY/headless transport, mode toggle,
history — **stays exactly as is**. ContextProcess only adds *capture → bind →
summarize*, and the *grid* query.

---

## 6. Implementation status

* [x] Spec (this document)
* [x] Backend: `GraphContext.summary()` (`flow_sdk/builtin/graph_context.py`)
* [x] Backend: `AgenticProcess.set_graph_context()` — bind + mirror onto
      `shared_context_entities` + pre-launch freeze guard
* [x] Backend: single `_system_prompt_additions()` accumulator, injected on the
      headless launch path (`agentic_process.py` `_AgenticContext`)
* [ ] Backend: wire the same accumulator into the **PTY** launch
      (`--append-system-prompt`) — headless covers conversation/message/diagnose;
      PTY covers visible chat tabs
* [ ] Backend: `summary` HTTP action on `graph_context` (for UI display)
* [ ] Backend: `processes_in_context` / `last_process_in_context` query (§4 grid)
* [ ] Frontend: generalize `captureContext()`; message surface adds message id;
      call `set_graph_context` at the message launch site
* [ ] Frontend: entities × processes grid
