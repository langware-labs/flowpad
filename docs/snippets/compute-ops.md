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

## 3. A fallback is two ops, and a retry is the caller's

There is no ladder inside an op. "Try the command, then the agent" is two ops
with the same check — when the first reached the goal, the second's check holds
and it does nothing:

```jsonc
{ "name": "ripgrep-on-path",
  "subkind": "cli",
  "exe_data": {"commands": {"linux": "apt-get install -y ripgrep"}},
  "completion_check": {"commands": {"linux": "command -v rg"}} }
```

```jsonc
{ "name": "ripgrep-on-path-agent",
  "subkind": "agent",
  "exe_data": {"agent": "provisioner", "timeout_seconds": 600},
  "completion_check": {"commands": {"linux": "command -v rg"}} }
```

A wizard sequences them (`on_fail: continue` on the first), or Python does. An
agent's answer names its process in `executor`; a caller that wants a second
turn in the SAME session runs the next op with `executor=answer.executor`. A turn
that ran out of time is `timed_out` — that process is busy, not done, so it is
not prompted again on top of itself.

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
