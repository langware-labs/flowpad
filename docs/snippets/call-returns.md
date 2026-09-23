---
id: 26f5399a-af9d-4b55-8b64-3b1166ac11b1
---
# Call → ExitCode → Return

One answer for every call in the system. A ComputeOp, a wizard, a shell command,
an agent turn and a person's reply all come back as a `ReturnedValue` — or the
subclass their kind of work carries.

**Every fence on this page is checked.** `tests/unit/test_call_returns_snippets.py`
runs every `python` fence as written; a line ending `# <expected>` is asserted
(`expr == expected`, prose after ` — ` is ignored). Every `pyi` fence is a
shape listing, and its fields are checked against the real class. A fence that
needs a real agent harness or an LLM source says so on its first line and runs
in the long tier (`tests/long_tests/test_call_returns_live.py`).

The decisions behind this page were made one problem at a time in review
(2026-09-22); the 23-site audit that prompted them is at the end.

---

## 1. A ComputeOp is one call

An op is ONE call of one subkind. It is not a ladder: a fallback — "try the
command, then the agent" — is two ops and a caller, in Python or a wizard.

Following [the ontology](../ontology.md): the type is `compute_op`, `subkind`
is a closed enum, and each subkind's structure is its own DataSpec, the kind
`compute_op.<subkind>`, nested in `exe_data` — never flattened onto the op.

```pyi
class ExeData(DataSpec):                      # no kind of its own
    timeout_seconds: float | None             # unset ⇒ the default for the ROLE (§6)

class CliOp(ExeData):                         # compute_op.cli — also every completion check
    commands: dict[str, str]                  # sys.platform → shell one-liner

class PromptOp(ExeData):                      # compute_op.prompt — a model, no tools
    prompt: str

class AgentOp(ExeData):                       # compute_op.agent — a harness with tools
    agent: str
    prompt: str

class AskOp(ExeData):                         # compute_op.ask — a person
    prompt: str

class ComputeOpSpec(AssetDocumentSpec):       # compute_op.json
    name: str
    label: str
    description: str
    subkind: OpSubkind                        # cli | prompt | agent | ask
    exe_data: CliOp | PromptOp | AgentOp | AskOp
    output_spec_kind: str | None              # a registered DataSpec kind, or a primitive
    completion_check: CliOp | None            # the SAME class as a cli op's exe_data
    not_applicable_codes: list[int]
    setup: Text                               # setup.md — what an agent or a model is given
```

```jsonc
{ "name": "ripgrep-on-path",
  "subkind": "cli",
  "exe_data":         {"commands": {"darwin": "brew install ripgrep"}},
  "completion_check": {"commands": {"darwin": "rg --version"}, "timeout_seconds": 30} }
```

## 2. Every call answers with a `ReturnedValue`

```pyi
class ReturnedValue(DataSpec):                # compute.returned
    exit_code: ExitCode                       # OK 0 · NOT_YET 1 · NOT_APPLICABLE 3 · NOT_FOUND 4 · REFUSED 7
    value: Any                                # an instance of output_spec_kind
    detail: str                               # ONE sentence for a person
    ran: bool                                 # False ⇒ nothing executed
    timed_out: bool                           # the wait ended before the work did
    duration_s: float
    executor: str | None                      # 'agentic_process-<id>' | 'shell-<id>'
    check: CliResult | None                   # the last completion-check run

class CliResult(ReturnedValue):               # compute.returned.cli
    command: str                              # as resolved for this platform
    returncode: int | None                    # the process's own exit; None ⇒ never finished
    stdout: str
    stderr: str

class PromptResult(ReturnedValue):            # compute.returned.prompt — a prompt AND an agent
    text: str                                 # the full reply, beside the declared value

class AskResult(ReturnedValue):               # compute.returned.ask
    cancelled: bool

class WizardResult(ReturnedValue):            # compute.returned.wizard
    steps: dict[str, ReturnedValue]           # step id → that step's OWN answer
```

| subkind | answers with | `executor` |
| --- | --- | --- |
| `cli` | `CliResult` | `None`, or `shell-<id>` when it ran in a terminal |
| `prompt` | `PromptResult` | `None` |
| `agent` | `PromptResult` | `agentic_process-<id>` |
| `ask` | `AskResult` | `None` |

A caller that only composes reads the base; a caller that knows what it called
reads the rest. There is no wrapper. A NESTED answer — a wizard step's, a
check's — is `Tagged`: its dump carries `spec_kind`, so it reads back as the
same subclass.

## 3. One call, a re-check, and the evidence on the answer

```python
install = ComputeOpSpec(
    name="marker",
    subkind="cli",
    exe_data=CliOp(commands={"darwin": "touch done.txt"}),
    completion_check=CliOp(commands={"darwin": "test -f done.txt"}, timeout_seconds=30),
)
first = await run_op(install, trusted=True, workdir=tmp)
type(first) is CliResult                  # True
first.exit_code, first.ran                # (ExitCode.OK, True)
first.returncode, first.command           # (0, 'touch done.txt')
first.executor                            # None — a plain subprocess
first.check.command                       # 'test -f done.txt' — the re-check that decided it

again = await run_op(install, trusted=True, workdir=tmp)
again.exit_code, again.ran                # (ExitCode.OK, False) — the check held; nothing ran


broken = ComputeOpSpec(
    name="build",
    subkind="cli",
    exe_data=CliOp(commands={"darwin": "echo 'error: missing header' >&2; exit 2"}),
)
answer = await run_op(broken, trusted=True, workdir=tmp)
answer.exit_code                          # ExitCode.NOT_YET
answer.returncode                         # 2
answer.stderr                             # 'error: missing header\n'
answer.detail                             # 'The command exited 2.' — one sentence


slow = ComputeOpSpec(name="slow", subkind="cli",
                     exe_data=CliOp(commands={"darwin": "sleep 5"}, timeout_seconds=0.2))
answer = await run_op(slow, trusted=True, workdir=tmp)
answer.exit_code, answer.timed_out        # (ExitCode.NOT_YET, True) — a fact, not an exit code
```

## 4. The output is a named DataSpec

```python
class Greeting(DataSpec):
    spec_kind: ClassVar[str] = "snippet.greeting"
    text: str

hello = ComputeOpSpec(name="hello", subkind="cli",
                      exe_data=CliOp(commands={"darwin": "echo '{\"text\": \"hi\"}'"}),
                      output_spec_kind="snippet.greeting")
answer = await run_op(hello, trusted=True, workdir=tmp)
type(answer.value) is Greeting            # True — not an anonymous class
answer.value.text                         # 'hi'

try:
    ComputeOpSpec(name="x", subkind="cli", exe_data=CliOp(commands={"darwin": "true"}),
                  output_spec_kind="snippet.greetin")
except ValidationError as refused:
    reason = str(refused)
"unknown kind 'snippet.greetin'" in reason    # True — refused at read, never Any
```

That `class Greeting(DataSpec)` is the registration: a kind exists once the
module declaring it has been imported. So a kind is nameable here — in flow_sdk,
or in an asset that ships a module, like a data source — and NOT in an op's own
folder, which holds a JSON document and a markdown file. An op returns a
primitive or a kind that already exists. The rule, and the one mechanism to
reuse if that changes, are in [ontology](../ontology.md).

## 5. Nothing raises for an outcome

Refused, busy, never started, timed out, failed: all returned. Only bad input
(`ValidationError`, above) and a broken system raise. A caller who would rather
raise opts in, and the exception carries the answer.

```python
broken = ComputeOpSpec(name="build", subkind="cli",
                       exe_data=CliOp(commands={"darwin": "exit 2"}))

refused = await run_op(broken, trusted=False, workdir=tmp)
refused.exit_code, refused.ran            # (ExitCode.REFUSED, False) — not approved; nothing ran
type(refused) is CliResult                # True — the subkind's own class, even here

try:
    (await run_op(broken, trusted=True, workdir=tmp)).raise_for_status()
except OpNotReached as failed:
    carried = failed.answer
carried.returncode                        # 2 — the exception CARRIES the result
```

| what happened | `exit_code` | `ran` | how a caller tells |
| --- | --- | --- | --- |
| not approved | `REFUSED` | False | never retry |
| someone else is running it (a wizard's lock, a turn in flight) | `NOT_YET` | False | nothing ran — try later |
| never started (no harness, spawn failed) | `NOT_YET` | False | `detail` says why |
| still running when the wait ended | `NOT_YET` | True | `timed_out` — do not re-run on top of it |
| ended in error / interrupted | `NOT_YET` | True | the process, via `executor` |
| a reply that is not the declared kind | `NOT_YET` | True | `text` keeps the reply |

Waiting on a person is an `ask` op in progress, like any other op — there is no
`PENDING`. Error vs interrupted is not copied onto the answer; the process row
has it, through `executor`.

## 6. A timeout is resolved by the role a call plays

One class serves as both the completion check and a cli op's work, so the
default belongs to the READER. An explicit value always wins; nothing is raised.

```python
CliOp(commands={"darwin": "true"}).timeout()                  # 600.0 — CLI_TIMEOUT, as the work
CliOp(commands={"darwin": "true"}).timeout(CHECK_TIMEOUT)     # 30.0 — as a completion check
CliOp(commands={"darwin": "true"}, timeout_seconds=5).timeout(CHECK_TIMEOUT)   # 5 — explicit wins
PromptOp(prompt="hi").timeout()                               # 120.0 — PROMPT_TIMEOUT
AgentOp(agent="provisioner").timeout()                        # 1800.0 — AGENT_TIMEOUT
AskOp(prompt="token").timeout()                               # 60.0 — ASK_TIMEOUT_SECONDS
```

A person gets the SHORTEST of what the op asks for, what the caller allows and
`ASK_TIMEOUT_SECONDS` — a caller may shorten it, never lengthen it.

## 7. A person's answer, asked once

The check decides whether to ASK. A valid answer is the verdict — a person, not
a command, verified it — so an ask is not re-checked. Storing it is the
caller's cli op, the value travelling in `env`, never templated into a command.

```python
class ApiToken(DataSpec):
    spec_kind: ClassVar[str] = "snippet.api_token"
    token: str

get_key = ComputeOpSpec(
    name="get-api-key", subkind="ask",
    exe_data=AskOp(prompt="Service X API token"),
    completion_check=CliOp(commands={"darwin": "cat token.json"}),
    output_spec_kind="snippet.api_token",
)
store_key = ComputeOpSpec(
    name="store-api-key", subkind="cli",
    exe_data=CliOp(commands={"darwin": 'printf \'{"token": "%s"}\' "$TOKEN" > token.json'}),
)

key = await run_op(get_key, trusted=True, workdir=tmp)       # a person types sk-live-1
type(key) is AskResult                    # True
key.exit_code, key.ran                    # (ExitCode.OK, True)
key.value.token                           # 'sk-live-1'
stored = await run_op(store_key, trusted=True, workdir=tmp, env={"TOKEN": key.value.token})
stored.ok                                 # True

again = await run_op(get_key, trusted=True, workdir=tmp)
again.ran, again.value.token              # (False, 'sk-live-1') — read off the check; nobody asked
```

A cancel and a silence are both "no value": `NOT_YET`, told apart by
`cancelled` and `timed_out`. An answer that is not the declared kind never
reaches the op — the window gets a 422 and the question stays open.

## 8. A wizard answers with its steps' own answers

A wizard sequences calls. Its answer is a `WizardResult` whose `steps` are the
ops' own results; a step never reached is absent. This is also how a fallback
is written: a cli op, then an agent op with the same check — when the first
reached the goal, the second's check holds and it does nothing.

```python
install = ComputeOpSpec(name="marker", subkind="cli",
                        exe_data=CliOp(commands={"darwin": "touch done.txt"}),
                        completion_check=CliOp(commands={"darwin": "test -f done.txt"}))
broken = ComputeOpSpec(name="build", subkind="cli",
                       exe_data=CliOp(commands={"darwin": "echo 'error: missing header' >&2; exit 2"}))
ops = {"marker": install, "build": broken}

async def resolve(name):
    return Resolved(ops[name], trusted=True)

result = await run_wizard(
    WizardSpec(name="setup", steps=[
        WizardStepSpec(id="make", ref="marker"),
        WizardStepSpec(id="compile", ref="build"),
        WizardStepSpec(id="deploy", ref="marker"),
    ]),
    trusted=True, workdir=tmp, resolve_op=resolve, platform="darwin",
)
type(result) is WizardResult              # True
result.exit_code                          # ExitCode.NOT_YET
result.detail                             # 'The command exited 2.' — the step that stopped it
type(result.steps["make"]) is CliResult   # True — the op's OWN answer
result.steps["compile"].stderr            # 'error: missing header\n'
"deploy" in result.steps                  # False — never reached (on_fail: abort)
stored = WizardResult.model_validate(result.model_dump(mode="json"))   # what run.json reads back
type(stored.steps["compile"]) is CliResult   # True — restored by its spec_kind
stored.steps["compile"].returncode           # 2
```

`run.json` is this dump plus `approved`. `Wizard.run_state` serves it without
step output (stdout, stderr, text, value); `run-detail` serves it whole.

## 9. An agent names its process, and a caller continues it

```python
# long tier — needs a real agent harness (tests/long_tests/test_call_returns_live.py)
fix = ComputeOpSpec(name="marker-agent", subkind="agent",
                    exe_data=AgentOp(agent="provisioner", prompt="Create an empty file named done.txt here."),
                    completion_check=CliOp(commands={"darwin": "test -f done.txt", "linux": "test -f done.txt"}))

first = await run_op(fix, trusted=True, workdir=tmp)
type(first) is PromptResult               # True
first.exit_code                           # ExitCode.OK — the agent made the check hold
first.executor.startswith("agentic_process-")   # True

# A follow-up has no completion check: with one that already holds, nothing
# would run — a satisfied op never calls anything, continued or not.
follow_up = ComputeOpSpec(name="which-file", subkind="agent",
                          exe_data=AgentOp(agent="provisioner", prompt="Which file did you just create? One word."))
second = await run_op(follow_up, trusted=True, workdir=tmp, executor=first.executor)
second.ran                                # True
second.executor == first.executor         # True — the same process, the same session
"done" in second.text.lower()             # True — it remembers: the session carried over
```

The op says WHAT; `executor` says WHERE. A caller's retry is exactly this — the
op never loops. The session, the models and the token use live on the process:
`AgenticProcess.get_by_typeid(first.executor)`.

## 10. A model, no tools

```python
# long tier — needs an API-capable LLM source on this box
summary = ComputeOpSpec(name="summary", subkind="prompt",
                        exe_data=PromptOp(prompt="Say the single word: pong"))
answer = await run_op(summary, trusted=True, workdir=tmp)
type(answer) is PromptResult              # True
"pong" in answer.text.lower()             # True
```

The box's default LLM source answers. A box with no API-capable source (only a
signed-in vendor CLI) answers `NOT_YET`, `ran=False`.

---

## The 23 sites, and what each became

| # | site | became |
| --- | --- | --- |
| 1 | `WizardRunResult.returned()` | deleted — `WizardResult` IS a `ReturnedValue` |
| 2 | `check_op` | the check's `CliResult`, its `exit_code` the verdict |
| 3 | `flow op run` | exits `returned.exit_code`; a bad document or a 500 exits 2, never `REFUSED` |
| 4 | `ComputeOp.run_action` | 200 with the answer for every exit code, `REFUSED` included |
| 5 | `ComputeOp.run` | returns `REFUSED` |
| 6 | `hook_models._exec_script` | `CliResult` |
| 7 | `Shell.run` (REST) | `CliResult`, `executor='shell-<id>'` |
| 8 | `Wizard.run` | `WizardResult` |
| 9 | `_agent_attempt` | deleted — the `agent` subkind → `PromptResult` + `executor` |
| 10 | `CommandExecutor.run` | `CliResult` |
| 11 | `ComputeNodeCommandExecutor.run` | `CliResult`; a missing exit stays `None`; a given timeout is enforced |
| 12 | `_attempt` (command rung) | deleted — the `cli` subkind → `CliResult` |
| 13 | `_ask_attempt` | the `ask` subkind → `AskResult` |
| 14 | `run_shell` | `CliResult` |
| 15 | `run_op` | one call → the subkind's answer; `REFUSED` returned |
| 16 | `launch_step_process` | `PromptResult` + `executor` |
| 17 | `Shell.run_and_capture` | `CliResult`, `executor='shell-<id>'`, `timed_out` |
| 18 | `run_wizard` | `WizardResult`; no `PENDING`; `REFUSED` returned |
| 19 | `AgenticProcess.run` | `PromptResult`; no `ProcessError` |
| 20 | `_AgentRunner.run` | `PromptResult`; no `RuntimeError` |
| 21 | `routes/ask.py` | unchanged — the HTTP edge a window delivers an answer through |
| 22 | `execute_wizard` | `WizardResult`; busy → `NOT_YET`, `ran=False` |
| 23 | `AgenticProcess.prompt` | `send_turn()` → `PromptResult`; busy → `NOT_YET`, `ran=False` (the HTTP action keeps its 409) |
