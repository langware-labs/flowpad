---
id: 239cd419-8f92-5bee-bdf5-40e3188a2b6d
---

test 1: Doc-chat panel mounts on every editable doc-type with asset_ref-resolved target
- for each url under `{plan,agent,skill,markdown,claude_md,claude_memory}` open the corresponding asset editor URL
  - plan: {APP_URL}/dock/assets/editor/plan/Users/shlom/.claude/plans/zazzy-toasting-newell.md
  - agent: {APP_URL}/dock/assets/editor/agent/Users/shlom/.claude/agents/ea-test-agent-1776959943595.md
  - skill: {APP_URL}/dock/assets/editor/skill/Users/shlom/.claude/skills/amd_mock
  - markdown: {APP_URL}/dock/assets/editor/markdown/Users/shlom/Documents/dev/flowpad-oss/docs/discovery.md
  - claude_md: {APP_URL}/dock/assets/editor/claude_md/Users/shlom/Documents/dev/flowpad-oss/CLAUDE.md
  - claude_memory: {APP_URL}/dock/assets/editor/claude_memory/Users/shlom/.claude/projects/-Users-shlom-Documents-dev-flowpad-oss/memory/MEMORY.md
- validate `[data-testid="entity-execution-panel"]` is present
- validate the panel's nearest React fiber `EntityExecutionPanel` has prop `target` matching `<type>-<uuid>` (proves asset_ref → entity TypeId resolution via useEntityByPath)
- validate the chat textarea with placeholder "Ask about this doc…" is visible and NOT disabled (`taDisabled === false`)
- validate `[data-testid="entity-execution-status"]` is null/absent (no active process yet — empty state)
- validate `[data-testid="entity-execution-history"]` exists but is `disabled` (hasHistory === false on a fresh editor)

INVARIANT: target prop is `<RecordType>-<uuid>` (NOT a path string). The asset_ref refactor
stores `asset_ref` uniformly on Record.meta_dict, and `useEntityByPath` resolves it. If target
is null/empty, send is gated via `sendDisabled`. Markdown was just registered as a ts_sdk
Entity (was missing) — this is the regression that test 1 protects against.

Naming note: the component was renamed from EntityChatPanel to EntityExecutionPanel
during the refactor; testids follow the new name (entity-execution-*).

test 2: First send lazy-creates AgenticProcess and status indicator transitions
- pick markdown URL from test 1
- type "hi" in textarea with placeholder "Ask about this doc…"
- press Enter (or click send button)
- validate within 5s: `[data-testid="entity-execution-status"]` becomes present (process was just lazy-created in `handleSend`)
- validate status text transitions from initial → busy state — observe `getStatusLabel` output: should be one of `STARTED`/`RUNNING`/`THINKING` while busy
- validate sendDisabled === true while busy (chat input shows disabled cursor)
- wait for DONE status (timeout 60s)
- validate the ASSISTANT chat message renders with non-empty content
- validate `[data-testid="entity-execution-history"]` becomes enabled (hasHistory === true now that one chat exists)

INVARIANT: spawn site is in `EntityExecutionPanel.tsx`'s `handleSend` — `computeNode.createProcess({ targetTypeIdStr, outputFormat: 'stream-json' })` is invoked only on first send, never on mount.

test 3: Refresh after a completed chat does NOT show stuck "Thinking" status
- continue from test 2 with a DONE process attached to the markdown doc
- reload the page (F5 / page.reload())
- wait for editor to remount
- validate `[data-testid="entity-execution-panel"]` re-mounts and the past process is auto-picked
- validate `[data-testid="entity-execution-status"]` text equals "DONE" or absent (terminal state) — NOT "Thinking" or "Started"
- validate textarea is enabled (`taDisabled === false`) — no false busy-state lock

REGRESSION: useDerivedWorkerStatus now skips items with `source === FlowDataSource.History`.
Before the fix, hydrating history would replay assistant-START events and the indicator
latched on "Thinking" with no completion event to clear it. This test will fail if that
filter is removed.

test 4: target prop changes when switching between doc-type editors (asset_ref invalidation)
- open the plan URL; capture EntityExecutionPanel.target as `t_plan`
- navigate to the agent URL via the same browser tab (in-app navigation, not full reload)
- validate the new EntityExecutionPanel.target !== `t_plan` and starts with `agent-`
- validate the chat panel resets — no leftover messages from plan visible — because `useEffect([targetStr])` clears `selectedProcessId`/`forceNew`

INVARIANT: when the editor pointer changes type, the upstream target string changes →
EntityExecutionPanel re-keys its picker state and `useProcessesForTarget(targetStr)` queries
fresh.

test 5 (BUG already in app — keep as known issue, don't fail the run):
- on first send to a fresh markdown doc, console may emit "Cannot update a component
  (`EntityExecutionPanel`) while rendering a different component (`EntityExecutionPanel`)"
- this is a setState-in-render warning originating in the localProcess /
  resolvedMatchesLocal effect chain.
- record the warning if seen but DO NOT fail the test on it. File a separate bug.
