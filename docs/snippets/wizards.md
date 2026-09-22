---
id: 0a52d5f6-1145-46fd-b1c5-3cc08ed932d5
---
# Wizards — a sequence of calls, and what travels between them

A Wizard SEQUENCES calls. Each step names one thing — a ComputeOp or another
wizard — and reads one answer back. Everything about HOW work is done lives in
the op ([compute-ops](compute-ops.md)); what is left here is what only a
sequence owns: order, `on_fail`, the values steps pass each other, and the one
answer the run gives back ([call-returns](call-returns.md) §8).

Every `python` fence on this page runs as written, by
`tests/unit/test_wizards_snippets.py` — each `# expected` comment is an
assertion, so a fence cannot claim a value the code does not return. Commands
are spelled for `darwin` and the platform key is pinned, so the same fence runs
on a Linux box.

---

## 1. Order, and a step that had nothing to do

```python
marker = ComputeOpSpec(name="marker", subkind="cli",
                       exe_data=CliOp(commands={"darwin": "touch done.txt"}),
                       completion_check=CliOp(commands={"darwin": "test -f done.txt"}))

async def resolve(name):
    return Resolved(marker, trusted=True)

result = await run_wizard(
    WizardSpec(name="setup", steps=[
        WizardStepSpec(id="make", ref="marker"),
        WizardStepSpec(id="again", ref="marker"),
    ]),
    trusted=True, workdir=tmp, resolve_op=resolve, platform="darwin",
)
result.ok                          # True
result.steps["make"].ran           # True — the goal did not hold, so it ran
result.steps["again"].ran          # False — by then it did
result.ran                         # True — the RUN did work, whatever its last step did
```

`ran` is the run's own, not its last step's: a wizard that installed something
and then found everything else in place did NOT do nothing.

## 2. A value from one step reaches the next as ENVIRONMENT

```python
port = ComputeOpSpec(name="port", subkind="cli", output_spec_kind="int",
                     exe_data=CliOp(commands={"darwin": "echo 8080"}))
record = ComputeOpSpec(name="record", subkind="cli",
                       exe_data=CliOp(commands={"darwin": 'echo "$FLOWPAD_WIZARD_INPUT_PORT" > port.txt'}),
                       completion_check=CliOp(commands={"darwin": "test -s port.txt"}))
ops = {"port": port, "record": record}

async def resolve(name):
    return Resolved(ops[name], trusted=True)

result = await run_wizard(
    WizardSpec(name="wire", steps=[
        WizardStepSpec(id="read", ref="port", bind="PORT"),
        WizardStepSpec(id="write", ref="record"),
    ]),
    trusted=True, workdir=tmp, resolve_op=resolve, platform="darwin",
)
result.ok                              # True
result.value["read"]                   # 8080 — every step's value, by step id
(tmp / "port.txt").read_text()         # '8080\n'
```

What a command prints is read as JSON when it parses as JSON, so `echo 8080`
is the `int` 8080 — declare the kind the output IS, not the text it looks like.
`bind` names the value; the callee reads it as `FLOWPAD_WIZARD_INPUT_<NAME>`.
Never interpolation — a value of `; rm -rf /` substituted into a command line
would be executable, straight through the gate that decides whether this wizard
may run shell at all. As environment it can change what a command sees and
never which command runs.

## 3. A fallback is two steps with the same check

```python
attempt = ComputeOpSpec(name="attempt", subkind="cli",
                        exe_data=CliOp(commands={"darwin": "false"}),
                        completion_check=CliOp(commands={"darwin": "test -f tool"}))
fallback = ComputeOpSpec(name="fallback", subkind="cli",
                         exe_data=CliOp(commands={"darwin": "touch tool"}),
                         completion_check=CliOp(commands={"darwin": "test -f tool"}))
ops = {"attempt": attempt, "fallback": fallback}

async def resolve(name):
    return Resolved(ops[name], trusted=True)

result = await run_wizard(
    WizardSpec(name="toolchain", steps=[
        WizardStepSpec(id="cheap", ref="attempt", on_fail="continue"),
        WizardStepSpec(id="thorough", ref="fallback"),
    ]),
    trusted=True, workdir=tmp, resolve_op=resolve, platform="darwin",
)
result.steps["cheap"].exit_code    # ExitCode.NOT_YET — it ran and did not get there
result.steps["thorough"].ok        # True — the second rung reached the goal
(tmp / "tool").exists()            # True
result.ok                          # True — the GOAL holds; the rung that missed is on the step
```

`on_fail: "continue"` is what makes the pair a fallback rather than an abort,
and the shipped `dev-toolchain` wizard is four steps of exactly this shape — a
`cli` rung and an `agent` rung per tool, sharing a check. When the cheap rung
reaches the goal the expensive one costs one check and answers `ran=False`.

**A wizard answers for GOALS, not attempts.** Two rungs of a fallback are one
goal and say so by carrying the same completion check, so a rung that failed and
was covered by a later step reaching that same goal does not make the run a
failure — the miss stays visible on its own step. A step with a goal of its own
that nobody reached still does: had `thorough` checked something else, the run
would be `NOT_YET` and name it.

## 4. A declared output binds

```python
stamp = ComputeOpSpec(name="stamp", subkind="cli", output_spec_kind="string",
                      exe_data=CliOp(commands={"darwin": "echo ok"}))

async def resolve(name):
    return Resolved(stamp, trusted=True)

promised = WizardSpec(name="promises", output={"port": "int"},
                      steps=[WizardStepSpec(id="stamp", ref="stamp", bind="stamp")])
result = await run_wizard(promised, trusted=True, workdir=tmp,
                          resolve_op=resolve, platform="darwin")
result.exit_code                      # ExitCode.NOT_YET
result.steps["stamp"].ok              # True — the STEP was fine
"not the declared output" in result.detail     # True
```

A wizard that declares an `output` is held to it, exactly as an op is held to
its `output_spec_kind`, and through the same seam. Promising a shape and
returning something else is a failure here rather than a surprise in whatever
binds the value later; the steps stay on the answer, so what WAS produced is
still readable.

## 5. A wizard that calls itself answers, and never recurses

```python
loop = WizardSpec(name="loop", steps=[WizardStepSpec(id="again", kind="wizard", ref="loop")])

async def resolve_wizard(name):
    return Resolved(loop, trusted=True)

result = await run_wizard(loop, trusted=True, workdir=tmp,
                          resolve_wizard=resolve_wizard, platform="darwin")
result.exit_code                                          # ExitCode.NOT_YET
"already on this run's stack" in result.steps["again"].detail    # True
result.ran                                                # False — nothing was done
```

A cycle is caught by NAME, because that is what the hazard is; `MAX_WIZARD_DEPTH`
is the backstop for the other runaway, a chain that never repeats but never
ends. Neither is a crash: unbounded nesting would end in one, and a crash is not
an answer.

---

## What a step's `on_fail` decides

| `on_fail` | a step that fails | later steps |
| --- | --- | --- |
| `abort` (the default) | stops the run | absent from `steps` — never reached |
| `continue` | is recorded and passed | run in order |

A REFUSAL is not covered by either: it stops the run whatever `on_fail` says,
because continuing past an untrusted callee is exactly what the trust gate
exists to prevent. The run then answers `REFUSED`, naming what it could not
call — and `ran` still reports whether earlier steps did real work.
