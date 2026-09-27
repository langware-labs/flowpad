---
id: 48fe7963-b589-4540-ae1d-6bf0b53fcb1c
---
# Compute ops — one call that converges, composes, and can ask

A ComputeOp is ONE call of one subkind — a shell one-liner (`cli`), a model
(`prompt`), an agent with tools (`agent`), or a person (`ask`). It declares the
kind it RETURNS, and it knows when it is already done — so running it twice does
the work once. Every op answers with a `ReturnedValue`; the shapes, and every
decision behind them, are on [call-returns](call-returns.md).

Every fence on this page is pinned. The `jsonc` documents are validated against
the real spec by `tests/unit/test_compute_ops_snippets.py`; the Python is the
entity API that `tests/api/test_ask_op_entity.py` runs — `by_name` then `run()`.

A command is written per platform (`commands: {"darwin": …}`), because that is
what the spec takes: one op, one goal, and whatever each machine needs to reach
it.

---

## 1. An op that gets a value from a person

```python
key = await ComputeOp.by_name("get-api-key")
answer = await key.run(approved=True)     # an AskResult
answer.exit_code         # ExitCode.OK once a person answers
answer.value             # 'sk-live-…' — what they typed, held to output_spec_kind
```

The completion check is "do we already have it?", the call is the question,
and `output_spec_kind` is what the person provides:

```jsonc
{ "name": "get-api-key",
  "subkind": "ask",
  "exe_data": {"prompt": "Service X API token"},
  "completion_check": {"commands": {"darwin": "flow secret get service-x/token"}},
  "output_spec_kind": "string" }
```

`output_spec_kind` names a REGISTERED kind — a primitive, or a DataSpec with a
`spec_kind` — and an unknown one is refused when the document is read. An op
cannot declare a shape of its OWN: this folder holds a JSON document and a
markdown file, and a kind is registered by importing the module that declares
it. See [ontology](../ontology.md) for what to do the day an op needs one.

The op raises the question and waits a bounded time. A live tab is sent to
`win/`, the chrome-less layout where the routed view IS the window; with no tab
listening, a window is opened at the same address. `ASK_TIMEOUT_SECONDS` is 60;
a caller may pass a shorter deadline, never a longer one.

The question is held by the backend, because that is where the answer arrives.
An op run anywhere else — a script, a worker — hands the question to the backend
(`POST /api/v1/ask`) and keeps its lease on it until the person has answered or
the deadline has passed. With no backend to ask through, it answers `NOT_YET`
with `ran=False` and says so.

An op that is install-time infrastructure — the machine cannot proceed without
it, and giving up only means asking again next boot — sets
`"until_answered": true` in its `exe_data` and waits with no deadline. The
price of that is one rule: a question that could not be shown to anyone (no
live tab, no browser — a headless sandbox) is dropped at once and answers
`NOT_YET` with `ran=False`, because an unbounded wait with nobody to answer
never ends.

`approved=True` is not optional. An op that is not a system op answers
`REFUSED` unapproved — before it puts a question to anyone.

## 2. Asked once, never again

```python
answer = await key.run(approved=True)     # the completion check now passes
answer.ok                  # True
answer.ran                 # False — nobody was asked a second time
answer.value               # 'sk-live-…' — read off what the check printed
```

`ran=False` is the whole point of a convergent op: it reports *skipped*, not
*completed*, so a caller can tell "it was already true" from "I just did it".

An ask op does not store the answer: storing it is the caller's `cli` op, with
the value passed in `env` — never templated into a command line. After a valid
answer an ask op is NOT re-checked: a person verified it.

## 3. A ladder of `attempts`, any kind but `ask`, one check the whole way down

"Try the command, then the agent" is ONE op: a cli call, then `attempts` —
further rungs, in order, tried while the completion check still fails. Each
rung names its own `subkind` and `exe_data`, same shape as the op's own —
cli, prompt or agent, in any mix, as many as are named. The check runs before
anything, after the op's own call, and after every rung — it is the only
verdict, never a rung's own exit code:

```jsonc
{ "name": "ripgrep-on-path",
  "subkind": "cli",
  "exe_data": {"commands": {"linux": "apt-get install -y ripgrep"}},
  "attempts": [
    {"subkind": "agent",
     "exe_data": {"agent": "provisioner", "prompt": "Install ripgrep on this machine.", "retries": 1}}
  ],
  "completion_check": {"commands": {"linux": "command -v rg"}} }
```

```
check       holds?             → done, nothing ran
command     check holds after? → done, attempts[0] never starts
attempts[0] check holds after? → done
  retries   the SAME session, told what the check printed, while it still fails
attempts[1] (none here — as many rungs run as are named)
```

`attempts` needs a `completion_check` — nothing else could say a rung missed —
and no rung may be `ask`: a person belongs at the wizard level, where declining
(Skip) stops only the one step asking, which nothing inside an op can express.
Past that, a rung's kind and position are the author's: an agent can come
before a cli rung, two cli rungs can differ by platform fallback, or several
agents can chain. The answer is the last rung's own (`PromptResult` once an
agent ran), its `detail` saying what the attempt before it said.

`retries` on an agent rung is further turns in its own session, not new
processes: the prompt carries only the check's command, exit code and output
tail — the task is already in the session. A turn that ran out of time is
`timed_out` — that process is busy, not done, so it is not prompted again on
top of itself, and the next `attempts` entry (if any) runs instead.

A fresh rung (agent or prompt) is not blind to the ones before it: its own
prompt is prefixed with what every EARLIER rung tried and reported ("Earlier
attempts at this same goal: …"), so a third rung does not waste a turn
rediscovering what the first two already found out. A within-session retry
gets none of this — the process it continues already remembers its own turns.

A caller can still continue an agent by hand: its answer names its process in
`executor`, and `run_op(spec, …, executor=answer.executor)`
(`flow_sdk/core/compute_op/runner.py`) runs the next op in that SAME session —
the entity's `ComputeOp.run()` takes no `executor`. See
[call-returns](call-returns.md) for the worked example.

**Two ops sharing one check still work as a fallback in a wizard** — a wizard
counts goals, not attempts, so a step that missed and a later step that reached
the SAME check do not fail the run. See
[wizards](wizards.md#3-a-fallback-is-two-steps-with-the-same-check). Reach for
that shape (not `attempts`) when a rung needs its OWN check, or when a person
must be asked before either one runs.

---

## What a cancel and a silence answer


| what happened | exit code | `value` | told apart by |
| --- | --- | --- | --- |
| answered, and it is the declared kind | `OK` | the value | — |
| the person cancelled | `NOT_YET` | none | `cancelled` |
| nobody answered before the deadline | `NOT_YET` | none | `timed_out` |

Both refusals are `NOT_YET` — each means *the goal does not hold, and you may
try again*. `REFUSED` stays what it is: "not approved to run here".

An answer that is NOT the declared kind never reaches the op. It is a 422 the
window shows, with the question still open, so the person corrects it rather
than the op failing on their behalf.
