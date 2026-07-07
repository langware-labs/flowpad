---
id: 29430b8b-4024-5ed6-b018-2b2ea34b70d1
---

> REWRITTEN 2026-07-07 (QA cycle, v0.2.93). The original scenario described a
> `ConversationView.tsx` implementation that no longer exists (4-way branch on
> Task metadata `agentic_session_id`/`agentic_process_id`/`agentic_workdir` +
> `taskSessionCache`) and asserted white-box internals not observable via E2E.
> Spawn/reuse now lives in `useMyProcess.ts` (`openOrStart`) and headless
> execution in the backend `execute-prompt` action
> (`flow_sdk/app/actions/execute_prompt.py`, triggered via
> `useApproveAndExecute.ts`). Tasks carry `my_process_id` only. This rewrite
> encodes the current, E2E-observable contract; the original text is in git
> history.

# Conversation task process lifecycle — spawn, reuse, no duplication

Contract under test (`ui/src/components/conversation/useMyProcess.ts`):

- **First run** on a task-bound conversation: `openOrStart()` spawns a VISIBLE
  `AgenticProcess` with `{workdir: task.project_root, projectId:
  task.project_id}`, stamps `task.my_process_id = <new process id>`, and
  navigates the dock to the process's terminal dockPointer.
- **Follow-up** while that process exists: `openOrStart()` calls
  `existing.start()` and opens the SAME dockPointer — no second process is
  created for the task (one process per task).
- **Hard guard**: without `task.project_root` the hook refuses to spawn
  (console warning, no crash, no process).

test 1: first run spawns a visible process, stamps my_process_id, opens its dock
- seed via REST: a Task with `project_root` (a real workdir), `project_id`, and
  no `my_process_id`, attached to a Conversation (create both via
  POST /api/v1/graph/task and /api/v1/graph/conversation; link per current API
  shape)
- capture the agentic_process count via GET /api/v1/graph/agentic_process
- open the conversation surface for that task in the browser
- click the Start affordance (the chip renders its start label while
  `task.my_process_id` is absent)
- validate via API poll: exactly ONE new agentic_process entity exists; it is
  `visible=true`; its `project_id`/`workdir` match the task's
- validate `task.my_process_id` (GET the task) equals the new process id
- validate the dock URL navigated to that process's terminal dockPointer

test 2: follow-up reuses the existing process — no duplicate
- with test 1's state (task.my_process_id set, process alive), click the chip
  again (it now renders its open label)
- validate via API: the agentic_process count is UNCHANGED (no second process
  for the task) and `task.my_process_id` still points at the same id
- validate the dock URL is the same process's terminal dockPointer

COVERAGE NOTE: the original test 3/4 "dead process resume with
resumeSessionId" branches have no current UI equivalent — resume-on-reopen is
owned by the process lifecycle itself (`existing.start()` recovers the PTY;
see terminal/pty recovery coverage). The headless Approve & Execute path
(`execute-prompt` on a flow_message) is backend-owned and requires an inbound
message fixture; it is covered at the API layer by the hub/message suites, not
by this browser scenario.
