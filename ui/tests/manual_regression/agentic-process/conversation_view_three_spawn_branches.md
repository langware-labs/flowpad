---
id: 29430b8b-4024-5ed6-b018-2b2ea34b70d1
---

> TEST-ISSUE (2026-06-04): This scenario describes a `ConversationView.tsx`
> implementation that no longer exists. It references a 4-way spawn branch at
> ConversationView.tsx:136/142/156/169, a `taskSessionCache`, and Task metadata
> keys `agentic_session_id` / `agentic_process_id` / `agentic_workdir`. None of
> these are in the current code: `taskSessionCache` does not exist anywhere;
> ConversationView no longer branches on those metadata keys; spawn now lives in
> `useApproveAndExecute.ts` (reuse-most-recent-AP-else-spawn; fork from
> `task.my_process_id`'s session for context) and `useMyProcess.ts`
> (`openOrStart`: existing→start, else `AgenticProcess.spawn({workdir, projectId},
> {instruction, visible})` + set `task.my_process_id`). Tasks now carry
> `my_process_id`, not the trio above. The scenario's assertions are also
> white-box (spawn called with exact args, internal cache contents) and not
> observable through E2E without instrumentation, and the branches require
> pre-seeded Tasks in specific live/dead process states.
>
> A faithful current-behavior rewrite would test, via the UI:
>  - first run on a task-bound conversation spawns a VISIBLE process + stamps
>    `task.my_process_id` + opens its terminal dockPointer;
>  - a follow-up while that process is RUNNING reuses it (start + open), no dup;
>  - Approve & Execute spawns a headless run forked from `my_process_id`'s session.
> That rewrite needs conversation/task seeding that is out of this scenario's
> scope; flagged as test-issue rather than fabricating a green test.

test 1: ConversationView "first run" branch — brand-new session spawn (ConversationView.tsx:169)
- prerequisite: a Task record with NO `agentic_session_id`, `agentic_process_id`, or `agentic_workdir` in metadata
- navigate to the conversation surface for that task (open from a session-card or /dock/conversation/<id>)
- type an instruction and submit
- validate AgenticProcess.spawn is called with `{ workdir }` only (no resumeSessionId) — POST to /api/v1/graph/save creating a new agentic_process record
- validate the dock navigates to the new agentic_process dockPointer
- validate the Task record metadata is updated with `agentic_session_id`, `agentic_workdir`, and `agentic_process_id`
- validate `taskSessionCache` now contains the spawned process for this taskId

test 2: ConversationView "live resume via existing process" branch — reconnect PTY (ConversationView.tsx:136)
- prerequisite: a Task with `agentic_process_id` pointing to a process whose status is RUNNING (not STOPPED/FAILED/STOPPING)
- open the conversation for that task; submit a follow-up instruction
- validate NO new AgenticProcess is spawned — `existingProcess.start({ instruction })` is called instead
- validate the dock opens the existing process's dockPointer
- validate no duplicate agentic_process records are created (one process per task)

test 3: ConversationView "dead process resume" branch — close + spawn with resumeSessionId (ConversationView.tsx:142)
- prerequisite: a Task with `agentic_process_id` AND `agentic_session_id`, where the process status is STOPPED or FAILED
- open the conversation for that task; submit an instruction
- validate the dead process is closed (existingProcess.close()) before spawning
- validate AgenticProcess.spawn is called with `{ workdir, resumeSessionId: <stored_session_id> }` and `visible: true`
- validate POST body's cli_config contains `resume: true` and `session_id: <stored_session_id>`
- validate Task metadata `agentic_process_id` is updated to the new resumed process id (session_id stays the same)
- validate the dock navigates to the resumed process's dockPointer

test 4: ConversationView "legacy resume" branch — session_id stored, no process_id (ConversationView.tsx:156)
- prerequisite: a Task whose metadata has `agentic_session_id` but NO `agentic_process_id` (older record format)
- open the conversation for that task; submit an instruction
- validate AgenticProcess.spawn is called with `{ workdir, resumeSessionId }` and `visible: true`
- validate Task metadata is updated to include the new `agentic_process_id`
- validate the resumed process appears in the dock and renders prior transcript turns

COVERAGE NOTE: tests 1, 3, 4 exercise the three spawn sites at ConversationView.tsx:142, 156, 169.
test 2 covers the no-spawn live-reconnect path. Together they fully cover ConversationView's branching
on the asset_ref-aware AgenticProcess schema (no asset_ref field is set by ConversationView itself —
it only passes through `workdir` and `resumeSessionId`, which are unaffected by the asset_ref refactor).
