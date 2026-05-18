---
id: a4ae24fe-3c17-5014-bec3-e87a8bcb3370
---

test 1: Resume an existing Claude session from Recent / History navigates into a live AgenticProcess
- prerequisite: at least one claude_session record exists in the index AND the corresponding AgenticProcess is currently not open in a visible tab (close any matching tab first)
- navigate to {APP_URL}/dock/home
- open the History modal (or Recent sessions list — whichever surface uses useResumeInTerminal / AgenticProcess.fromClaudeSession)
- click a recent claude_session entry
- validate the URL changes to /dock/shell/agentic_process-<id>
- validate no duplicate processes were created (one process per session_id — exercises upsertSessionProcess)
- validate the Info popover "Session ID" matches the claude_session record's id
- validate the transcript lens (Open Transcript button) shows the prior conversation

test 2: Notification / terminal toolbar entry point reuses the same resume flow
- trigger an error notification that carries a session_id (e.g. via /dock/lens/claude/errors, clicking a row's "Open in terminal" affordance)
- click the action button that maps to useResumeInTerminal / openClaudeSession
- validate the dock navigates to /dock/shell/agentic_process-<id> for the same session
- validate no duplicate AgenticProcess is created on the backend

test 3: Session-card click derives session UUID from asset_ref (post source_path -> asset_ref rename)
- prerequisite: at least one indexed claude_session record
- via the global search dock, query for a known claude_session and click its primary card
- inspect the network request payload: GET .../claude_session result rows include `asset_ref` shaped as
  `/<absolute>/.claude/projects/<encoded>/<uuid>.jsonl` (the legacy `source_path` field MUST NOT be
  read by the frontend — record-type-nav.ts:28 sessionIdFromResult parses asset_ref's filename)
- validate the dock navigates to /dock/shell/agentic_process-<uuid> where <uuid> matches the jsonl
  filename (without extension)
- validate Transcript sub-action also resolves: clicking it opens
  /dock/lens/claude/transcript/<encoded>/<uuid> using projectEncodedNameFromResult(asset_ref)

COVERAGE NOTE: a single assertion that no duplicate process is created covers the upsertSessionProcess
contract across record-type-nav, HistoryModal, use-resume-in-terminal, and NavigationActions.openClaudeSession
— all converge on AgenticProcess.fromClaudeSession.
