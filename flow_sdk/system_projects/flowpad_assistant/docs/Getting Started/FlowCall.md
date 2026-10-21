---
id: dd4a6fea-fb05-4748-b207-d2f8160c6b96
title: FlowCall
---

# FlowCall

FlowCall is Flowpad’s contract for invoking work, receiving a structured outcome and value, and composing that result into further work.

It is one mechanism implemented by several parts, not a class to instantiate:

| Name | Meaning |
|---|---|
| `ComputeOp` / FlowCall block | A reusable definition with typed input/output and an execution implementation |
| `ReturnedValue` | The answer, extended by `CliResult`, `PromptResult`, `AskResult`, and other specialized results |
| `ExitCode` | The outcome vocabulary |
| `Wizard` | A sequence that keeps step answers and binds their values into later inputs |
| `ProcessCall` | A message-carried call correlated with its answer |
| `CollectionResult` | An explicit map's per-item answers, preserving input index and optional domain key |

## Build a block

Keep the asset at `agentic-assets/compute_op/<name>/compute_op.json`. Its
`input` and `output` use the existing schema authoring form: a registered kind,
record shape or `[element-shape]`. Use a data-schema asset or SDK schema for
public domain kinds; schema discovery must not execute unapproved code.
`output_spec_kind` remains compatible for existing named-output declarations.

A Python-backed block declares `subkind: python` and implements
`async def call(input, *, context) -> ReturnedValue` in its own `call.py`.
A sync function is supported too. Return `ReturnedValue.satisfied(value=result)`
for success, and the appropriate returned outcome for expected failure. Bare
lists/dictionaries are not answers. Helpers live beside the entry and use
relative imports. Existing CLI/agent/model/ask/decision/navigation blocks do
not need a generated Python wrapper.

Call an indexed block through `ComputeOp.resolve(ref, project=...)`, then
`await block.call(input=value, approved=True)`. Resolve a TypeId or an
unambiguous project-scoped name. TypeScript uses
`block.call<Output>(input, {approved: true})`; the server still validates its
schemas. Approval means permission to execute the block's code, not merely
permission to view its metadata. A Python call can route through
`await context.call(ref, input=value, approved=...)`; the child needs its own
authorization.

The SDK and CLI accept typed inputs; the built-in ComputeOp viewer's existing
Run button does not provide a typed input editor.

## Lists and chaining

A block declaring a list receives the whole list. This suits deduplication,
filtering, sorting and aggregation. An empty list is a successful value.
`chain` from `flow_sdk.core.compute_op.composition` passes whole values through
the existing Wizard runner and retains each step's answer. `map_calls`
explicitly invokes one block per element, sequentially. It stops on failure
unless `on_error="collect"` is requested; refusal always stops, and programming
or transport errors still raise. A partial batch never masquerades as a complete
output list. Each consumer validates its actual input before running; a producer
may already have had effects before that validation fails. No implicit flattening,
retries or rollback.

Use `exit_code == ExitCode.OK` and `has_value` for required data edges.
`.ok` also accepts `NOT_APPLICABLE`; that is not proof of an output value.
`value_present=True` marks explicit output, including schema-valid null;
unmarked legacy null is ambiguous. Zero, false and `[]` are not absent.
Named-schema values may be ValueRef strings; `context.resolve` materializes
them explicitly rather than hiding I/O in validation. Its default is the
block's value store; pass `near=<store path>` for another owner. There is no
cross-project search.

`invocation_id` correlates an answer and its child work. Use Activity and the
executor to observe progress/completion; do not make a fresh request/status-file
protocol or find child processes by name and time. Triggers schedule calls,
GraphWorkflow owns event routing, and sources own pages/streams. A finite list
is not a Dataset or a live stream.

Read `exit_code` for the outcome, `value` for the output, and `detail` for the
human explanation. Facts such as `ran`, `busy`, `timed_out`, and `reported`
distinguish what happened without parsing that explanation. A declared output
is validated before a later step uses it; tagged serialization preserves typed
values and nested answers across storage.

An HTTP request succeeding does not mean the work succeeded. Expected outcomes
such as refusal or an unmet goal are returned; raising for them is a caller's
explicit choice. Likewise, `send_turn()` returning OK means **accepted**;
`run()` waits for the result. Ordinary SDK queries and transport envelopes are
not all FlowCall answers.

For questions about FlowCall, ReturnedValue, or how calls return and compose
values, begin with this contract. Do not assume the question is about HTTP or
WebSocket plumbing. In a Flowpad source checkout, the detailed specification
and executable examples are in `docs/snippets/call-returns.md`; the answer schema
is `flow_sdk/schema/data_spec/returned_value_spec.py`. Those checkout paths are
optional references, not prerequisites for this shipped guide.

The full runnable `call.py` and list-chain example is
`docs/snippets/flowcall-blocks.md`, pinned by
`tests/unit/test_flowcall_blocks_snippets.py` in a source checkout.

## Durable calls

Use `ComputeOp.start(input=..., approved=True)` in Python or
`op.start(input, {approved: true})` in TypeScript when work must outlive a client
request. Admission returns a private call record with `call_id` and
`invocation_id`; retain the block identity and call ID. Read it with
`ComputeOp.get_call(call_id)` / `op.get_call(callId)`. Reading never starts work.

The record state is `running`, `completed`, `interrupted`, or `failed`.
Only a completed record carries the tagged `ReturnedValue` in `result`; still
check its outcome and value presence before chaining. A completed refusal is
not successful output. Validation rejects invalid input before admission, and
approval still precedes executable imports. Each start creates new work:
invocation correlation is not an idempotency key and an uncertain request must
not be silently retried.

Records survive backend restarts. Unfinished work whose executor has stopped
is reported interrupted without replay; this does not roll back prior effects.
A surviving external agent is not, by itself, proof that its enclosing Python
block can resume. Persisted executor information is for correlation, not a
promise of checkpoint recovery. Awaited `call` and Wizard composition retain
their existing contracts.
