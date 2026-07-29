---
id: 0f85fa0c-9d65-53bd-84a6-9e6abee86dfe
---

test 1: visible=true AgenticProcess created via createProcess stays on the PTY (interactive-terminal) path

Context:
- AgenticProcess lifecycle routing is driven by the `visible` field:
    - visible=true  → interactive PTY worker (the terminal tab the user types into).
    - visible=false → print-mode worker (ClaudeCLIStreamWorker), admitted via POST
                      /agentic_process/<id>/prompt.
- The new `prompt` action MUST reject visible=true processes (PTY owns the session):
  flow_sdk/builtin/agentic_process/agentic_process.py::_http_prompt returns 409 when
  `self.visible` is True.
- _scan_create_process (flow_sdk/builtin/faas/scan_actions.py) must NOT attach
  `target_typeid_str` unless the caller puts it into the context explicitly (that path
  is reserved for triggers, markdown-attached processes, etc.).

Steps:
- GET {HUB}/api/v1/graph/bootstrap — extract default_compute_node.id (the @local CN).
- POST {HUB}/api/v1/graph/compute_node/<cn_id>/createProcess with
      body = { "context": { "workdir": "<any existing workdir>" }, "visible": true }
  Expect HTTP 200, status:SUCCESS, data.type == "agentic_process", data.id is a UUID.
- GET  {HUB}/api/v1/graph/agentic_process/<process_id>
  Expect:
    visible           === true
    target_typeid_str === null     (was popped from context but none was sent)
    workdir           === the workdir we passed
    instruction_content === ""     (no instruction on this code path)
    worker_status     === "idle"   (PTY not yet attached — attach happens via WS
                                    /start_pty or when the shell tab mounts)
- POST {HUB}/api/v1/graph/agentic_process/<process_id>/prompt
      body = { "message": "hello from qa" }
  Expect HTTP 409, status:FAIL,
  message starts with "process is PTY-interactive; prompt action requires visible=false".
- Cleanup: DELETE {HUB}/api/v1/graph/agentic_process/<process_id>  → 200.

Notes on what is NOT exercised here:
- We do not open a WebSocket terminal_command/start — starting a PTY session requires
  a live WS connection_id (pty_actions.py:177). The createProcess path only creates
  the AgenticProcess entity; the PTY is spawned on shell attach. The admission check
  (step 4) is the load-bearing assertion that lifecycle routing branches correctly on
  `visible`.

KNOWN REGRESSION SHIELDS:
- If a future refactor forgets to pop `target_typeid_str` from context_data before
  passing to ClaudeAgentOptions, createProcess will raise (extra kwarg) — so this
  scenario fails fast at step 2.
- If the `/prompt` admission gate gets moved/removed, step 4 flips from 409 to 200
  and a print-mode worker would race the PTY on the same session_id.
