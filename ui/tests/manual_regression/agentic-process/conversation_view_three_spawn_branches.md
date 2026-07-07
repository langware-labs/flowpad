---
id: 29430b8b-4024-5ed6-b018-2b2ea34b70d1
---

> PROVENANCE
> - ORIGINAL scenario described a `ConversationView.tsx` implementation that no
>   longer exists (4-way branch on Task metadata
>   `agentic_session_id`/`agentic_process_id`/`agentic_workdir` +
>   `taskSessionCache`) and asserted white-box internals not observable via E2E.
> - FIRST REWRITE 2026-07-07 (QA cycle, v0.2.93) targeted `useMyProcess.ts`
>   (`openOrStart`, stamping `task.my_process_id`). That was an error: that hook
>   and its only consumer (`OpenInClaudeButton.tsx`) are DEAD CODE — the button
>   has zero render sites anywhere in `ui/src`/`ts_sdk/src`, so `openOrStart`
>   has no reachable UI trigger and `task.my_process_id` is never read/written by
>   any rendered component. The scenario could not pass as written.
> - THIS REWRITE 2026-07-07 encodes the ACTUALLY-SHIPPED conversation-session
>   lifecycle: `useConversationSession.ts` (start/open) surfaced by
>   `ConversationHeaderSession.tsx` (header `WorkerToolbar`) and the drawer's
>   `ConversationContextPanel.tsx` (Private Context "Add → Session"). The session
>   is keyed to the CONVERSATION, not a task: one `AgenticProcess` with
>   `process_type === 'conversation'` (`ProcessKind.Conversation`), linked onto
>   `conversation.shared_context_entities`, workdir/project from
>   `conversation.project_id`. There is no `task.my_process_id`.

# Conversation session lifecycle — launch, open-reuse, no duplication

Contract under test (`ui/src/components/conversation/useConversationSession.ts`,
`ConversationHeaderSession.tsx`, `ts_sdk/.../agentic-process.ts::launch`):

- **Launch** on a conversation with a mapped project: the header
  `WorkerToolbar` shows a launch button per worker. Launching spawns exactly one
  VISIBLE `AgenticProcess` with `{workdir: project.fs_storage_mount_path,
  projectId: conversation.project_id, processType: ProcessKind.Conversation}`,
  links its TypeId onto `conversation.shared_context_entities`, and navigates the
  dock to the process's terminal dockPointer
  (`/dock/shell/agentic_process-<id>`).
- **Open-reuse** once that session exists: the header collapses to a single
  **Open** button; clicking it re-opens the SAME dockPointer — no second process
  is created for the conversation (one conversation-session per conversation).

test 1: launch spawns a visible conversation-process, links it, opens its dock
- seed via REST: a Conversation whose `project_id` is a real project (the
  bootstrap `default_project`, whose `fs_storage_mount_path` is a real workdir);
  no session yet (POST /api/v1/graph/conversation)
- capture the baseline set of agentic_process ids via
  GET /api/v1/graph/agentic_process
- open the conversation surface (/dock/conversation/<id>) in the browser
- click the header's Start affordance (`conversation-launch-claude_code`, shown
  while no conversation-process exists)
- validate the dock URL navigated to `/dock/shell/agentic_process-<id>`; take
  that `<id>` as the launched process
- validate via API: exactly ONE new agentic_process exists vs the baseline; it
  is `visible=true`; its `process_type` is `conversation`; its `project_id`
  equals the conversation's `project_id` and its `workdir` equals the project's
  `fs_storage_mount_path`
- validate the conversation's `shared_context_entities` now contains
  `agentic_process-<id>`

test 2: opening again reuses the existing session — no duplicate
- seed a fresh Conversation (mapped to the same real project) and launch its
  session exactly as in test 1, capturing the launched process id and the
  conversation's linked conversation-process set (== the single launched id)
- return to the conversation surface; the header now renders the single **Open**
  button (`conversation-open-session`); capture the agentic_process count
- click Open
- validate the dock URL is the SAME `/dock/shell/agentic_process-<id>`
- validate via API: the agentic_process count is UNCHANGED (no second process),
  and the conversation's linked conversation-process set is still exactly the
  same single id

COVERAGE NOTE: the original test 3/4 "dead process resume with resumeSessionId"
branches have no current UI equivalent — resume-on-reopen is owned by the
process lifecycle itself (`existing.start()` / `openShellProcess` recovers the
PTY; see terminal/pty recovery coverage). The headless Approve & Execute path
(`execute-prompt` on a flow_message) is backend-owned and requires an inbound
message fixture; it is covered at the API layer by the hub/message suites, not
by this browser scenario. The dead `useMyProcess`/`OpenInClaudeButton`/
`task.my_process_id` path is a reported finding for the design owner to delete
or re-wire — it is intentionally NOT tested here because it renders nowhere.
