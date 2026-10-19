---
id: 7b5426fe-5d37-412a-bf86-cb3fa211bfb3
---
# Deploy checklist — "Set up" Git must not report false success

## Scenario

1. Open an agent whose project folder is **not** a git repository
   (`GET /api/v1/graph/agent/<id>/git_share_preflight` → `code: not-in-repo`).
   The test seeds one: a project in a fresh temp folder (not a git repo) with
   an agent created in it (`POST /api/v1/graph/project/<id>/agent`).
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

## Live-only

Success needs the wizard's real Claude agent to run the setup to completion,
and "set up" means a supported origin — the agent must create or link a hosted
(GitHub) repository. That is a live-Claude run with an outward-facing side
effect, so the test is skipped unless `QA_DEPLOY_LIVE_GIT=1` is set.

## Run

From `ui/`, against a running backend + frontend:

```bash
LOCAL_SERVER_PORT=6004 VITE_PORT=4098 npx playwright test \
  --config=tests/manual_regression/assets/playwright.config.ts \
  tests/manual_regression/assets/deploy_git_setup_false_success.md.ts
```

`QA_DEPLOY_LIVE_GIT=1` opts into the live run. `QA_DEPLOY_AGENT_ID` selects an
existing agent instead of seeding one.
