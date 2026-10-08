# `pr open` — preparing the PR

Run only after the step 4 report. **Every git step below is its own approval
gate.** Show what will happen, then wait for an explicit yes for that step. An
approval covers that step only. "Guide me" is not approval.

1. **Blockers stop here.** If the verdict is NOT READY, list the blockers and
   ask whether to fix them first. Don't open a PR over a failing gate unless the
   user explicitly says so.
2. **Base branch** — the highest `release/v0.x` (never `main` unless asked).
   Pull it into the branch first:
   `git fetch origin release/v0.x && git merge origin/release/v0.x`.
   **On any conflict, stop and tell the user.** Don't resolve it on your own.
3. **Uncommitted changes** — show `git status --short` and the proposed commit
   message, then wait. Never commit a rig, a report or a screenshot (see
   CLAUDE.md "Verification rigs").
4. **Push** — `git push -u origin <branch>`. Wait for approval first.
5. **Create** — title starts with the branch's Jira id (`FLOWPAD-1234: <summary>`).
   Body: what changed and why, how it was verified (the gates from step 2), the
   PR-check verdict, and any open PLAUSIBLE findings. End with the attribution
   line the session specifies. Show the title and body, wait, then
   `gh pr create --base release/v0.x --title … --body …`.
6. **Never merge.** Report the PR URL and stop. (The one exception, a version-bump-only
   PR, is the deploy skills' job, not this one.)

If CI fails later, re-dispatch only the failing test first
(`test.yml` inputs `backend-k` / `e2e-only` + `e2e-grep`). Don't wait on the whole suite.
