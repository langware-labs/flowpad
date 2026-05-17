---
id: 707df10b-94d3-512c-88e6-f8ef42f1d821
---

test 1: OpenInWorktreeButton spawns a worktree sibling; CommitMergeButton appears only inside the worktree
- prerequisite: a git-repo workdir with at least one commit (create a tmp dir, `git init && git commit --allow-empty -m init`)
- launch a Claude session in that workdir (e.g. via HomeLanding search, or navigate to /dock/shell/new_terminal?cwd=<path> and open the tab-opener "+" (data-testid="opener-plus-button") and pick the "Claude Code" row (data-testid="opener-menu-row-claude"))
- wait for the banner
- validate the OpenInWorktreeButton is ENABLED (tooltip mentions worktree) — `isGitRepoHasCommit` returns true
- validate the CommitMergeButton is NOT rendered in this tab (cliOptions.worktree is false on the parent process)
- click OpenInWorktreeButton
- wait for a new /dock/shell/agentic_process-<id> tab to appear
- in the new tab: validate the Info popover row "Worktree" reads "enabled" and Command contains `--worktree`
- validate the CommitMergeButton IS now rendered in the worktree tab
- validate the OpenInWorktreeButton is hidden OR disabled inside the worktree tab (cannot nest)

test 2: OpenInWorktreeButton is disabled when the workdir has no commits
- prerequisite: a directory that is either not a git repo OR a git repo with zero commits (`git init` with no commit)
- launch a Claude session in that workdir
- validate the OpenInWorktreeButton is disabled
- hover; validate the tooltip mentions needing a git repository with at least one commit

test 3: CommitMergeButton injects the commit+merge prompt into xterm and enters loading state
- continue from test 1 (we are in the worktree tab with CommitMergeButton rendered)
- make a dummy edit inside the worktree dir and stage it (e.g. `echo 1 > f.txt && git add f.txt`)
- click CommitMergeButton
- validate the xterm receives the commit+merge prompt text (visible in PTY output)
- validate the button transitions to a disabled/loading state (e.g. "Working…" label)
- wait for the worker to complete the turn (workerStatus returns to IDLE)
- validate the tab auto-navigates back to the shell view (navigation.openShellView()) — the parent tab regains focus

KNOWN BEHAVIOR: Auto-close of a worktree process on Exit is implemented backend-side in
flow_sdk/app/actions/listen.py::_close_worktree_process; this scenario exercises the
frontend trigger that sets that flow in motion.
