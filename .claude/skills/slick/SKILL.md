---
id: e7d69e47-4ca0-5d06-aa52-ea46e2974787
name: slick
description: 'The flowpad code-design lens. Use this whenever you are writing, reviewing,
  refactoring, or deciding WHERE logic belongs in the flowpad / flow-cli codebase
  — adding a feature, an action, an entity, a worker/vendor, or a dependency; judging
  "is this clean?"; or being asked to make code "slick". Trigger it even when the
  user doesn''t say "slick": any time you''re about to put logic in the frontend,
  branch on a string, hand-roll a parallel code path, or add a package, run this lens
  first. It tells you the right layer, the right seam, and the test that proves the
  code is slick. Supports two explicit modes: "slick check" (concise diagnosis of
  real violations) and "slick suggest" (the concrete changes to reach slick design).'
---

# Slick — flowpad code design

"Slick" is a placement-and-shape discipline. Most ugly code in flowpad is not
wrong logic — it's **right logic in the wrong layer**, or a special case bolted
onto shared infrastructure. This skill is the lens that catches that before you
write it.

It complements `CLAUDE.md` (the project root), which holds the *non-negotiable
rules* — URL-first navigation, entity-id policy (UUID v4/v5 via `mint_uuid`),
the single type registry, type icons from `TypeInfo`, and "never raise a
timeout." Read those as hard constraints. This skill is the *design judgment*
layered on top: where does this go, what's the seam, how do I prove it.

`references/anchors.md` is the concrete file/symbol index for every pattern
below — open it when you need the exact path or class to model after.

## Modes

The seven principles below are the rubric. There are three ways to apply them:

- **`slick` (default, while authoring)** — apply the lens as you write. No
  report; just produce slick code.
- **`slick check`** — diagnose. Run the rubric over the target and return a
  concise list of *real* violations. Diagnosis only — do not edit.
- **`slick suggest`** — prescribe. For the same violations, list the concrete
  change that reaches slick design. Still do not edit unless asked; this is the
  plan.

**Scope.** Default to the working-tree change (`git diff HEAD`; include
untracked files). If the user names a file, path, diff range, or PR, use that
instead. State the scope you used in one line.

### `slick check` — output contract

Goal: **high signal, zero noise.** Only flag violations of the seven principles
that materially hurt placement, reuse, or testability. When in doubt, leave it
out — a check that lists ten nits is worse than one that names the two real
problems.

In scope (flag these): logic computed in the frontend that the backend should
own; a frontend write that should go through an action; a parallel action/method
~95% duplicating an existing one; `if name == "x"` / bare-string branching on
shared infra that should be an enum or a driver trait; a bare string used for a
typed value; per-type behavior hardcoded at a call site instead of `TypeInfo`; a
new dependency that stdlib or an existing dep covers; a behavior that can't be
exercised in a REPL or a <15-line no-mock test (god-object / tangled surface).

Out of scope (do NOT flag): formatting, naming taste, micro-perf, anything
`CLAUDE.md` already governs (unless egregiously violated), and speculative
"could maybe" concerns. Don't restate what the code does.

Format — one line per issue, ordered by impact, then a one-line verdict:

```
slick check — scope: <what you scanned>
1. <file>:<line> — P<n> <principle tag> — <the violation in ≤12 words>
2. <file>:<line> — P<n> <principle tag> — <…>
Verdict: <N significant issues> | clean
```

If nothing significant, say exactly: `Verdict: clean` (plus the scope line).
Don't manufacture issues to fill the list.

### `slick suggest` — output contract

Same scope and same significance bar as `check`, but each item carries the fix.
Order by impact (the change that removes the most misplaced logic first). Be
concrete — name the layer, the seam, the symbol — using `references/anchors.md`.

Format:

```
slick suggest — scope: <what you scanned>
1. <file>:<line> — P<n> <principle tag>
   Now:  <what it does today, ≤1 line>
   Slick: <the concrete change — move to X / replace literal with EntityType.Y /
          collapse into the Z action / declare trait on the driver>
2. …
```

Keep each suggestion to the smallest change that reaches slick — not a rewrite.
If a fix would ripple well beyond the scope, say so and stop at the seam.

## The one question

Before writing any non-trivial code, ask: **"What is the lowest layer that can
own this, and can I exercise it there with no browser?"**

That single question resolves most slick decisions. The layers, lowest-owning
first:

```
built-in python  →  one focused package  →  worker harness / driver
   →  database query  →  backend entity + action  →  frontend (render only)
```

Push work down to the layer that can truly own it. The frontend is the *last*
resort, and it only ever renders or calls an action — never decides.

## The seven principles

### 1. Headless by default — the frontend renders, it does not decide

The frontend is a **projection of backend state**, never a source of truth.
The round trip is one-directional: a backend `Entity` changes →
`notify_updated()` → WebSocket `data_op` → the SDK `deepAssign`s it into the
cached entity → `handleFlowData` / subscribers re-render. The frontend's only
two jobs are (a) render state derived from the URL or an entity, (b) call an
action.

**Why:** anything the frontend *computes* can't be tested without a browser,
can't be reused by the CLI or an agent, and drifts from the backend's truth.
When the backend owns the computation (e.g. `Entity.private_context_entities`
is merged server-side and the frontend just renders the result), every surface
agrees for free.

**The test:** *could this behavior run with no browser — driven by `curl`, the
`flow` CLI, or a pytest?* If not, the logic is in the wrong layer.

- Slick: the `prompt` action branches on `process.visible` server-side; the
  frontend calls the same `prompt()` for both transports and knows nothing.
- Not slick: a `promptPty()` SDK method + `inject`/`launched` flags in a React
  component deciding how the backend should route. (This exact code existed and
  was deleted — the routing moved into the backend action.)

Corollary — this is the same spirit as the URL-first rule in `CLAUDE.md`: the
loader is the single writer; click handlers only `navigate(...)`.

### 2a. Push logic to the lowest layer that can own it

Don't solve in the UI what the backend can. Don't solve in the backend what a
database query or the worker harness already does. Each step down makes the
behavior more reusable and more testable.

**Why:** the lower the layer, the more callers benefit and the smaller the test.
A rule enforced in one SQL filter or one driver method can't be bypassed by a
second caller the way a UI-level check can.

### 2b. Prefer built-in Python; a new package must earn its place

Reach for the standard library first. Before adding a dependency, check: can
this be ~20 lines of stdlib? Is it already a transitive dep? Does it pull a
heavy tree for a small need?

**Why:** every package is install surface, version risk, and a thing the next
reader must learn. flowpad's dep list is already heavy (`anthropic`, `openai`,
`groq`, `usearch`, `tiktoken`, `numpy`) — each new one raises the bar for the
next.

- Slick: `flow_sdk/transcript_analyzer/` parses every vendor transcript with
  stdlib only — no parser framework, no pandas. It's the model citizen.

### 3. Entities are maintained, and a frontend entity reflects a backend one

Almost every frontend entity (`APIEntity` subclass, `@registerEntity`) mirrors a
backend `Entity` of the same type. New state lands on the **backend entity
first**; the frontend mirrors it via `data_op`. The frontend entity is a cache,
never the origin.

**Why:** one source of truth, reflected, means no reconciliation logic and no
"the UI says X but the DB says Y" bugs.

Corollary (see `CLAUDE.md` / project memory): every `EntityType` needs a paired
backend `Entity` class, or its `uname` and metadata never materialize.

### 4. Frontend ↔ backend is an action on an entity

The only channel is: `entity.ts` builds an `ActionInfo` and calls
`dataManager.callAction` → REST → `entity.py`'s `@action.post/get` method of the
**same `action_name`**.

```
new ActionInfo('prompt', AgenticProcess.type, id, 'POST')   // ts_sdk
        →  POST /graph/agentic_process/<id>/prompt
        →  @action.post(action_name="prompt")               // flow_sdk
```

**Rules that keep it slick:**
- Same `action_name` on both sides — grep-able as a pair.
- Generic behavior goes on the **base `Entity`** with `types="all"`; the named
  type is the first consumer, not the scope.
- **Don't add a parallel action when an existing one can branch.** One action
  that routes internally beats two near-identical actions and the SDK method
  each would need.

### 5. Always enum; per-type behavior lives in `TypeInfo`

Never compare or persist a bare string for a typed value — use `EntityType`
(`flow_sdk/schema/types.py`), the one canonical registry. Per-type metadata and
behavior (icon, `meta_model`, sync hooks, materialization) live in `TypeInfo`
and are resolved at runtime, **never hardcoded at a call site**.

**Why:** a string literal is an unchecked baseline — a typo or a renamed type
fails silently. An enum is a compile/lint-checked contract; `TypeInfo` means
adding a type lights up every surface (including the frontend icon registry,
which reads `iconForType` from the bootstrap, not a hardcoded map).

- Slick: `pty_submits_on_paste` declared on each `WorkerDriver`; resolved as
  `self.driver.pty_submits_on_paste`.
- Not slick: `ref.type == "agent"` / `self.driver.name == "claude"` scattered at
  call sites. (Real anti-patterns live in `agentic_process.py` — don't add more.)

### 6. Vendor/variant differences hide behind a driver, not an `if name ==`

Worker vendors (claude / codex / copilot) differ only behind the `WorkerDriver`
Protocol — as **declared traits** (`name`, `pty_submits_on_paste`) and
**methods** (`transcript_descriptor`, `tail_status`, `compose_prompt`). The
orchestrator (`AgenticProcess`) never branches on `driver.name`. Vendors share
generic abstractions: `WorkerStatus` for state, `AgentTranscriptFile` +
`TranscriptDescriptor` for transcripts.

**Why:** onboarding a new vendor should be one new driver file, not edits
sprinkled through the orchestrator. Mixing vendor logic into shared code is how
one vendor's quirk breaks another (e.g. copilot's `assistant.turn_end` once
mapped to the wrong status and pinned every copilot session "busy").

Generalize the rule beyond workers: **any time you're about to write
`if name == "x"` on shared infrastructure, the difference belongs as a trait or
method on the thing that varies.**

### 7. Console-testable — three ways, under fifteen lines

Code is slick when you can exercise the behavior **three ways**:

1. **REPL** — instantiate the entity and call the method:
   `Team(name="x").model_dump_json()` (no DB needed).
2. **CLI / HTTP** — hit the action: `curl …/graph/<type>/<id>/<action>` or a
   `flow record/navigate/context` command.
3. **A test** — a <15-line `pytest` or `vitest` with **no mocks**, driving the
   real entity + HTTP/WS path.

**Why:** if a behavior needs scaffolding to test, it's too entangled — the slick
version falls out naturally as a short function with a clear name. Real flowpad
unit tests are 13–46 lines; the cap is 30s and is never raised (a slow test
means slow code — fix the code).

- Slick: `type_id_str(t, id)` — one line, trivially tested.
- Not slick: a 100-method `AgenticProcess` god-object where a behavior can only
  be reached by booting a worker. Prefer short functions with clear names;
  done right, most functionality is provable in under ten lines.

## The "where does this go?" checklist

When you catch yourself about to write code, walk this:

1. **Can the database/query own it?** → write the filter, not Python.
2. **Is it a vendor/variant quirk?** → a driver trait/method, not an `if name`.
3. **Can a backend entity + action own it?** → put it there; the frontend calls
   the action.
4. **Am I about to compute in the frontend?** → stop. Render derived state;
   move the compute to the backend entity.
5. **Am I adding a second action/method that's ~95% an existing one?** → branch
   the existing one instead.
6. **Am I comparing a bare string for a typed value?** → use the enum.
7. **Can I exercise this in a REPL and a <15-line no-mock test?** → if not,
   it's too entangled; shrink the surface.

If a change forces a special case onto shared infrastructure, that's the signal
the fix isn't deep enough — generalize the underlying mechanism instead.
