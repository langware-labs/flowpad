# Deploy checklist — "Set up" Git must not report false success

## Scenario

1. Open an agent whose project folder is **not** a git repository
   (`GET /api/v1/graph/agent/<id>/git_share_preflight` → `code: not-in-repo`).
2. Deploy tab → "Before you can deploy" → **Git repository ready** → **Set up**.
3. The `git-context-folder` wizard popup opens and runs the setup agent.

## Expected

- The wizard's agent runs (its process has a transcript).
- The popup only closes as success once the repository exists — after it
  closes, `git_share_preflight` no longer returns `not-in-repo`.

## Observed (bug)

- The spawned `claude.EXE` exits in <1s with `0xC0000142` before reading its
  prompt (`stdin prompt write failed: Connection lost`), so no transcript.
- The popup auto-closes with `status: done` ("Git is set up" toast) while the
  folder is still `not-in-repo`.

## Run

From `ui/`, against a running backend + frontend:

```bash
LOCAL_SERVER_PORT=6004 VITE_PORT=4098 npx playwright test \
  --config=tests/manual_regression/assets/playwright.config.ts \
  tests/manual_regression/assets/deploy_git_setup_false_success.md.ts
```

`QA_DEPLOY_AGENT_ID` selects the agent (default `002c95c3-…`).
