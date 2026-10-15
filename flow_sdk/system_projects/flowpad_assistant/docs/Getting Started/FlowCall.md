---
id: dd4a6fea-fb05-4748-b207-d2f8160c6b96
title: FlowCall
---

# FlowCall

FlowCall is Flowpad’s contract for invoking work, receiving a structured outcome and value, and composing that result into further work.

It is one mechanism implemented by several parts, not a class to instantiate:

| Name | Meaning |
|---|---|
| `ComputeOp` | A configurable unit of work |
| `ReturnedValue` | The answer, extended by `CliResult`, `PromptResult`, `AskResult`, and other specialized results |
| `ExitCode` | The outcome vocabulary |
| `Wizard` | A sequence that keeps step answers and binds their values into later inputs |
| `ProcessCall` | A message-carried call correlated with its answer |

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
