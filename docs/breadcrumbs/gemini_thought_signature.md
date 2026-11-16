---
id: 45323355-ce60-4bf3-ab99-e88cde0f6983
title: A deepagents tool call carries its extra_content back to Gemini
tags:
- breadcrumb.test.gemini_thought_signature.rules
description: Gemini (Vertex's OpenAI-compatible surface, the default allowance's root)
  signs each function call in extra_content.google.thought_signature and refuses the
  next turn without it. LangChain's ChatOpenAI drops it, so deepagents keeps it on
  the AIMessage and echoes it back by tool-call id.
---
# A deepagents tool call carries its extra_content back to Gemini

> Ground truth. Proven by the fix b25587ad3 (PR #814, 2026-11-10): the bound test's deepagents rows failed without it and pass with it. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.gemini_thought_signature.rules
sites:
  - rel_path: "tests/long_tests/test_process_mcp_multi_vendor.py"
    line: 136
    note: "FAILING? on a deepagents row, read this tag's rules before touching EchoingChatOpenAI or the tool-call extra_content echo"
  - rel_path: "tests/long_tests/test_process_mcp_multi_vendor.py"
    line: 205
    note: "FAILING? on a deepagents row, read this tag's rules before touching EchoingChatOpenAI or the tool-call extra_content echo"
```

## Expected behavior

A deepagents turn funded through the hub (the test funds it with
`fund_worker_without_a_login`, i.e. the signed-in user's default allowance) calls the
dummy MCP tool and then finishes the turn with the tool's token in its answer.

## Internals

* **Gemini signs function calls.** Vertex's OpenAI-compatible chat-completions answer
  puts an opaque `extra_content` object (`extra_content.google.thought_signature`) on
  each tool call. The next request must send that object back, unchanged, on the same
  call, or Gemini answers 400 "Function call is missing a thought_signature".
* **LangChain drops it.** `ChatOpenAI` keeps only `id/type/function` of a tool call.
* **The fix** is in
  `flow_sdk/builtin/agentic_process/cli_drivers/deepagents/models.py`:
  * `_echoing_chat_openai()` (`models.py:27`) returns a `ChatOpenAI` subclass,
    `EchoingChatOpenAI`.
  * `_create_chat_result` and `_convert_chunk_to_generation_chunk` read each raw tool
    call's `extra_content` with `_extras_of()` (`models.py:18`) and store
    `{tool call id: extra_content}` under `additional_kwargs["tool_call_extra"]`
    (`TOOL_CALL_EXTRA`, `models.py:15`). The value lives on the AIMessage, so it
    survives the session checkpoint.
  * `_get_request_payload` (`models.py:58`) collects those maps from the input
    messages and puts each object back on the outgoing tool call with the same id.
* `openai_wire_model()` (`models.py:74`) builds the model from this class. It is the
  default `--model-factory` (`runner.py:48`, `DEFAULT_MODEL_FACTORY`).

## Invariants

* Every tool call whose response carried `extra_content` is sent back with the same
  object, matched by tool-call id, in streaming and non-streaming modes.
* A provider that sends no `extra_content` gets an unchanged payload.
* The deepagents model stays a `ChatOpenAI` instance (never an `openai:<slug>`
  string, which forces the Responses API a gateway does not speak).

## Failure modes

* **Before the fix:** the first turn ran the tool, and the next request after it was
  refused with "Function call is missing a thought_signature". The deepagents rows of
  both `test_attached_mcp_server_reaches_a_real_worker` and
  `test_agent_owned_mcp_reaches_a_real_worker` never got the token.
* Building the model with a plain `ChatOpenAI` again, or a LangChain upgrade that renames
  the overridden hooks (`_create_chat_result`, `_convert_chunk_to_generation_chunk`,
  `_get_request_payload`), brings the same refusal back on any Gemini-funded turn
  that uses a tool.
