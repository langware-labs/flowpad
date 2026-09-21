---
id: 48fe7963-b589-4540-ae1d-6bf0b53fcb1c
---
# Compute ops — work that converges, composes, and can ask

A ComputeOp is one unit of work with a goal. It declares what it RETURNS, and
it knows when it is already done — so running it twice does the work once.

Every fence on this page is pinned. The op documents are validated against the
real spec by `tests/unit/test_compute_ops_snippets.py`; the Python is run
literally — `by_name` then `run()`, through the entity — by
`tests/api/test_ask_op_entity.py`; the behaviour underneath runs in
`tests/unit/test_compute_op_ask.py` and — with a real browser answering §1 —
`tests/long_tests/test_ask_browser_matrix.py`.

A command is written per platform (`commands: {"darwin": …}`), because that is
what the spec takes: one op, one goal, and whatever each machine needs to
reach it.

**A person's answer is just an op's output.** Asking someone for an API key is a
goal ("do we have the key?") whose attempt happens to be a question. It needs no
new result type and no form machinery of its own.

---

## 1. An op that gets a value from a person

```python
key = await ComputeOp.by_name("get-api-key")
answer = await key.run(approved=True)
answer.exit_code         # ExitCode.NOT_YET — it asked; nobody has answered yet
answer.ran               # True — an attempt did happen
```

Its manifest is an ordinary op. The completion check is "do we have it?", the
attempt is the question, and `output` is what the person provides:

```jsonc
{ "name": "get-api-key",
  "completion_check": {"commands": {"darwin": "flow secret get service-x/token"}},
  "attempts": [{"kind": "ask", "prompt": "Service X API token"}],
  "output": {"token": "string"} }
```

The op raises the question and waits a bounded time. A live tab is sent to
`win/`, the chrome-less layout where the routed view IS the window; with no tab
listening, a backend is borrowed or started and a window is opened at the same
address. Neither is a new surface — `win/` and the `ui_command` push both
already existed; the push simply could not name a layout until now.

`ASK_TIMEOUT_SECONDS` is 60. A caller may pass a shorter deadline, never a
longer one.

`approved=True` is not optional. An op that is not a system op REFUSES to run
unapproved — it raises `ComputeOpNotApproved` rather than putting a question to
anyone, because a caller with no one to approve it should get a legible answer,
not a window.

## 2. Asked once, never again

```python
answer = await key.run(approved=True)   # the completion check now passes
answer.ok                  # True
answer.ran                 # False — nobody was asked a second time
answer.value.token         # 'sk-live-…' — read off what the check printed
```

`ran=False` is the whole point of a convergent op: it reports *skipped*, not
*completed*, so a caller can tell "it was already true" from "I just did it".

## 3. An agent rung that gets a second turn

```json
{ "name": "kafka-running",
  "completion_check": {"commands": {"linux": "<produce a fresh token, consume it back>"}},
  "attempts": [{"kind": "agent", "agent": "provisioner", "retries": 1, "timeout_seconds": 600}] }
```

`retries` is how many MORE turns the agent gets when its turn ends and the
completion check still fails. A retry is not a new process: the SAME process is
prompted again, in the same session, with what the check said — the command,
its exit code and the tail of its output — and the bar it must clear. The task
is not restated; it is already in the session, along with everything the agent
learned the first time. Default `0`: one turn.

A turn that ran out of time is not retried — that process is busy, not done,
and a second prompt would only queue behind it. An op with no completion check
retries on the rung's own failure instead, the only verification it has. Each
retry reports as its own probe (`agent retry 1`, …), and `timeout_seconds` is
per turn. Pinned by `tests/unit/test_compute_op_retries.py`; run for real in
Docker by `test_kafka_is_reached_by_one_agent_process_with_one_retry`.

---

## What a cancel and a silence answer

| what happened | exit code | `value` |
| --- | --- | --- |
| answered, and it satisfies the declared shape | `OK` | the value |
| the person cancelled | `NOT_YET` | none |
| nobody answered before the deadline | `NOT_YET` | none |

Both refusals are `NOT_YET` — each means *the goal does not hold, and you may
try again* — and they differ in `detail`, which is what a person reads.
`REFUSED` stays what it is: "not approved to run here".

An answer that does NOT satisfy the shape never reaches the op. It is a 422 the
window shows, with the question still open, so the person corrects it rather
than the op failing on their behalf.

## What is real today, and what is not

Real, and proven in a browser (`tests/long_tests/test_ask_browser_matrix.py`):
the `ask` rung, the question raised into `win/`, a typed answer coming back as
the op's value, cancel, the deadline, and the 422-then-correct path.

**Closed:** a converged op used to answer `OK` with no value, because the
runner kept the completion check's exit code and threw away what it printed. It
now reads the value off that output, so §2 returns it.

**One thing an ask op does not do yet:** store the answer. It returns it, but
nothing persists it where a completion check can find it, so an ask op WITH a
check keeps asking until something else writes the value down.
