---
id: c1523594-b918-4bc4-ad28-5f1c9654f90d
---
# FlowCall blocks — typed input, call.py, output

A **FlowCall block** is a reusable `ComputeOp`. Its definition stays in
`agentic-assets/compute_op/<name>/compute_op.json`; Python-backed blocks put
their entry function in `call.py`. CLI, agent, model, decision, ask and navigation
blocks keep their existing declarative implementations. They do not need a
Python wrapper.

The contract is `input → validation → call → ReturnedValue → output validation`.
The manifest uses the existing DataSpec authoring form: a kind name, a record
shape or a one-element list describing every element. `output_spec_kind` remains
the legacy named-output spelling. Conflicting `output` and `output_spec_kind`
declarations are rejected. Unknown declared kinds fail before execution.

The manifests, Python entries and caller below run as written in
`tests/unit/test_flowcall_blocks_snippets.py`.

## Input and output across block types

All seven variants validate declared input before execution. A supplied input
requires an `input` declaration; a declaration requires a supplied value,
including explicit `null` for a nullable shape. Output validation applies to
completed value-producing calls; invalid or missing required output becomes
`NOT_YET`, without a consumable value. An already-satisfied interactive goal may
return `OK` without a value; it cannot feed a chain that requires output.

| Variant | How validated input reaches the operation | Where its output value comes from |
| --- | --- | --- |
| Python | The `input` argument of `call(input, *, context)`; `context.workdir` carries the execution directory. | The returned `ReturnedValue.value`; returning a value requires an output declaration. |
| CLI | A typed folder at `FLOWPAD_CALL_INPUT_DIR`, containing the `input` field. Commands read that folder; input is never shell interpolation. | Parsed stdout, or the final check's stdout when a check is configured. JSON `null` is present; silent stdout is absent. |
| Prompt | JSON appended to the model's user prompt. | Parsed model response, validated against the declared shape. |
| Agent | Mounted typed input; primitives and lists use an `input` field wrapper. Explicit call input takes precedence over the legacy `exe_data.input` scope binding. | The declared result receipt after the launched work completes. Admission, process status and prose are not the receipt's value. |
| Decision | The state passed to the decision evaluator; explicit input takes precedence over the legacy scope binding. | The verdict's plain answer: one answer as a scalar, or multiple answers by question name. |
| Ask | `{{input}}` and `{{input.field}}` in the question, detail and setup guide display the supplied data. | The person's submitted value, using the declared output form. |
| Navigate | A declared DockPointer input when `exe_data.target` is absent; a configured target takes precedence. | The navigation result's value, if it supplies one. Opening a target alone does not manufacture required output. |

Agent receipts, CLI execution and Ask assistance use the resolved execution
working directory. Python's code folder remains separate from that directory.
An explicit nullable result is valid; an old unmarked null does not establish
value presence. Side-effect-only blocks need no output declaration.

## A real whole-list block

This example has two blocks in a project declaring `ns: flowcall_examples` in
`agentic-assets/project_manifest/project_manifest.json`. The namespace belongs
to the project; importing a block must not claim somebody else's schema names.
The example uses primitives, so it needs no domain-schema registration.

`agentic-assets/compute_op/dedupe/compute_op.json`:

```json
{"name":"dedupe","subkind":"python","input":["int"],"output":["int"],"exe_data":{}}
```

`agentic-assets/compute_op/dedupe/call.py`:

```python
from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue

async def call(input: list[int], *, context) -> ReturnedValue:
    return ReturnedValue.satisfied(value=list(dict.fromkeys(input)))
```

The callable receives one whole list. This preserves first occurrence; it is
not a per-item map. It returns an answer, not a bare list. `[]` is valid output.
Sync functions use the same signature and run off the event loop; asynchronous
functions are the natural choice when calling other blocks or performing I/O.
Relative helper imports stay inside the block's folder. Cancellation propagates;
a running sync function must settle before cancellation can finish, because its
thread cannot be safely terminated.

`agentic-assets/compute_op/sort/compute_op.json`:

```json
{"name":"sort","subkind":"python","input":["int"],"output":["int"],"exe_data":{}}
```

`agentic-assets/compute_op/sort/call.py`:

```python
from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue

async def call(input: list[int], *, context) -> ReturnedValue:
    return ReturnedValue.satisfied(value=sorted(input))
```

## Call and chain without a server

Run from that project root. The resolver carries each block's code folder
separately from the working directory. Explicit approval here means these local
files are code you have chosen to run. Discovery alone never imports `call.py`.

```python
from pathlib import Path

from flow_sdk.core.compute_op.composition import chain
from flow_sdk.core.wizard.runner import Resolved
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode

async def resolve_block(name):
    folder = Path("agentic-assets/compute_op") / name
    spec = ComputeOpSpec.model_validate_json((folder / "compute_op.json").read_text())
    return Resolved(spec, asset_folder=folder)

answer = await chain("dedupe", "sort").call(
    input=[3, 1, 3], approved=True, resolve_op=resolve_block,
)
assert answer.exit_code == ExitCode.OK
assert answer.value == [1, 3]
assert answer.steps["step_0"].value == [3, 1]

empty = await chain("dedupe", "sort").call(
    input=[], approved=True, resolve_op=resolve_block,
)
assert empty.value == []
assert empty.has_value
```

These exact manifest/call.py/caller fences are executed by
`tests/unit/test_flowcall_blocks_snippets.py`. The chain uses the Wizard runner;
it is not another scheduler. `WizardResult.steps` retains every reached answer,
while this chain's `.value` is the final step's value. Existing wizards still
return their collected step values unless `output_from` selects one step.
Each consumer validates the actual preceding value before executing; compatible
refinements such as `int` into `?int` are accepted. A producer may already have
run when its value fails the next input declaration. Chaining is not a transaction.

For indexed assets use `ComputeOp.resolve(ref, project=...)`, then
`await block.call(input=value, approved=True)`. Prefer a TypeId or a name scoped
to a project; ambiguous names are rejected. TypeScript uses
`await block.call<Output>(input, {approved: true})` through the existing `run`
action. The generic is a static hint; the server validates the declared shape.
Legacy `run` and `check` methods keep their contracts.
The built-in ComputeOp viewer's existing Run button does not supply typed
input; use the SDK/CLI or an application form that calls this API.

The CLI accepts `flow op run <ref> --input-json '<JSON>'` or
`--input-file <path>` (`-` reads stdin), with `--project` for scoped names. Input
is data, never interpolated into shell command text.

## Lists and partial results

`map_calls(block, items, approved=True)` explicitly invokes one block per item,
in order. It defaults to stopping at the first unsuccessful returned outcome.
`on_error="collect"` continues after expected returned failures; refusal always
stops. Programming errors, transport errors and cancellation still propagate.

`CollectionResult.items` records each reached input's index, optional domain key
and its own answer. A complete successful value-producing map returns the
ordered output list. A partial result has no consumable aggregate value; inspect
its item answers explicitly. A side-effect-only map returns no output value.
For a side-effect-only map, an already-satisfied or not-applicable goal may count
as success; a value-producing map requires `OK` and a present value per item.
There is no automatic flattening, filtering, retry or rollback. Dataset writes,
notifications and artifact writes can have effects before a later item fails.

## Tracing a run

`invocation_id` is the trace id of one top-level run: every call made inside it
carries the same one, and each also names the call that made it
(`CallContext.parent_call_id`; `None` for the run's root). `CallContext.call`,
`chain`, `map_calls` and Wizard steps pass both down. An `agent` block's worker
inherits them as `FLOWPAD_INVOCATION_ID` / `FLOWPAD_PARENT_CALL_ID`, so its own
`flow op run` calls join the run. `ComputeOp.start`, the `run`/`start` actions and
a `ProcessCall` take an optional `invocation_id` and `parent_call_id`; without one
the call is a run of its own.

A block opts into a call log with `"log": {}` in its `compute_op.json`
(`CallLogSpec`: `dataset_kind`, `max_rows` = 500, `max_row_bytes` = 65536). Each
call is then a row of the dataset
`<FLOWPAD_TEMP_DIR>/<instance>/agentic-assets/dataset/call-log-<block>/`, written
after the answer and never raising. Its `input` / `output` are
`{"value": ...}` of the block's shapes, or the rows of `dataset_kind` (the
block's eval set kind, so that eval reads the log). Its `data` holds the trace.
Temp is cleared by the OS and the oldest rows go past `max_rows`: copy a run out
whole with `call_log.promote(invocation_id, to=<dataset>)` to keep it.

A block that owns a named log says so in the same place: `name` (the folder,
instead of `call-log-<block>`), `title`, `enabled_by` (an instance preference
that turns the log on) and `row` (a function in its `call.py`,
`(input, answer) -> row | None`, writing the row as `dataset_kind` holds it;
`None` skips the call, and the trace joins the row's `data`). The
`smart-navigator` block is SmartNavigationLog this way: `navigator.dataset`
rows in `smart-navigation-log/`, on with Preferences → Advanced, and no row for
a `replay` -- an eval's request is no decision.

```sh
flow op trace <invocation_id>   # the run's logged calls, as a tree
```

`call_log.trace(invocation_id)` is the same tree in Python. A call whose parent
was not logged is a root.

Each row also names what produced it: `version` (`block_version`, a hash of
every file in the block folder) and `model` (the endpoint that answered a
`prompt` or `decision` op). Label rows as `eval` and the log is an eval set. A
dataset with no eval of its own kind falls back to the shipped `flowcall` eval,
which replays each row's input through its block as it is now, judges the answer
against the label, and slices the report by version and model. It replays only
blocks this instance ships or indexes. Run it with `python -m flow_sdk.evals
<log folder>`.

## Values, skips, references and routing

Use `exit_code == ExitCode.OK` and `has_value` before passing a required value.
`.ok` also accepts `NOT_APPLICABLE`, which is useful for goal sequences but is
not proof that a skipped producer supplied data. Empty lists, zero and false
are data; do not use truthiness as a presence check.

`value_present=True` distinguishes an explicit nullable result from no output.
`ReturnedValue.satisfied(value=None)` can satisfy a nullable declaration;
`ReturnedValue.satisfied()` cannot. Older answers with an unmarked null remain
readable but are ambiguous for new required-value chaining. Nested DataSpec
values retain their tags across result serialization. File content uses existing
typed folder I/O, not a path converted to a string.

Named-schema fields and list elements may contain existing ValueRef strings.
Generic validation preserves those references. `await context.resolve(value)`
explicitly materializes them from the block's value store; pass `near=<store path>`
for values owned by another store. It does not search other projects. Ordinary
values require no I/O. A Python function
that consumes a named schema must handle the reference alternative or resolve it.

`await context.call(ref, input=value, approved=...)` routes to another block
within the owning project using the same invocation machinery. Callee approval
is explicit; parent approval is not a blanket grant. Invocation IDs correlate
the answer, Activity and child work; they are not idempotency keys. Do not build
shared request/status files or find child processes by name and time.

Triggers schedule calls. GraphWorkflow owns event routing and durable graph
execution. Source drivers own sessions, cursors and streams. A finite list is
not a stream or a Dataset. Agent admission is not completed output: await the
result before chaining its value. See [FlowCall](call-returns.md),
[wizards](wizards.md) and [data shapes](data-spec.md).
