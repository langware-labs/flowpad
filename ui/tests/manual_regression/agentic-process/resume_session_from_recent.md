test 1: Resume an existing Claude session from Recent / History navigates into a live AgenticProcess
- prerequisite: at least one claude_session record exists in the index AND the corresponding AgenticProcess is currently not open in a visible tab (close any matching tab first)
- navigate to {APP_URL}/dock/home
- open the History modal (or Recent sessions list — whichever surface uses useResumeInTerminal / AgenticProcess.fromClaudeSession)
- click a recent claude_session entry
- validate the URL changes to /dock/shell/agentic_process-<id>
- validate no duplicate processes were created (one process per session_id — exercises upsertSessionProcess)
- validate the Info popover "Session ID" matches the claude_session record's id
- validate the transcript lens (Open Transcript button) shows the prior conversation

test 2: Notification / SessionActionButtons entry point reuses the same resume flow
- trigger an error notification that carries a session_id (e.g. via /dock/lens/claude/errors, clicking a row's "Open in terminal" affordance)
- click the action button that maps to useResumeInTerminal / openClaudeSession
- validate the dock navigates to /dock/shell/agentic_process-<id> for the same session
- validate no duplicate AgenticProcess is created on the backend

COVERAGE NOTE: a single assertion that no duplicate process is created covers the upsertSessionProcess
contract across record-type-nav, HistoryModal, use-resume-in-terminal, and NavigationActions.openClaudeSession
— all converge on AgenticProcess.fromClaudeSession.
