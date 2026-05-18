---
id: 273cd1d7-93e9-58d3-bcad-24b592465dd2
---

test 1: Git status button appears in agentic process terminal ribbon
- navigate to {APP_URL}/dock/shell/new_terminal
- click the "Start Claude" button if on a plain shell to create an agentic process
- wait for URL to match /dock/shell/agentic_process-/ (up to 60 seconds)
- wait for the bottom ribbon to initialize (idle/running LED visible)
- validate a GitBranch icon button is visible in the ribbon's right section (.ml-auto)
- validate it is the 3rd button (index 2) in the right section: Shell(0), Worktree(1), Git(2), Prompts(3), Queue(4), Files(5)
- validate no tooltip text says "Git status of the working directory" (tooltip appears on hover, not in DOM by default)

test 2: Git panel opens as a tab in the side window when Git button is clicked
- navigate to an agentic process with workdir set to a git repository
- click the GitBranch button (index 2 in .ml-auto)
- validate the side window appears on the right: a w-80 flex-col border-l div
- validate the tab strip (border-b inside the side window) shows a "Git" tab with the GitBranch icon
- validate the tab has a × close button (aria-label="Close Git")
- validate the Git panel content is visible below the tab strip
- validate the panel inner header shows the current branch name or "Not a git repo"
- validate the panel inner header has exactly 1 button: the Refresh (RefreshCw) icon
  (there is NO X close button in the panel header — closing is done via the tab strip ×)

test 3: Git panel header shows branch name and ahead/behind indicators
- navigate to an agentic process with workdir pointing to a git repo that has commits
  ahead of or behind its upstream (or just verify the branch name is correct)
- open the Git panel (click the GitBranch ribbon button)
- validate the branch name in the inner panel header matches `git branch --show-current` output
- if the local branch is ahead of upstream, validate a green "↑N" chip is shown
- if the local branch is behind upstream, validate an amber "↓N" chip is shown
- if on a detached HEAD or no upstream, validate no ahead/behind chips are shown

test 4: Git panel shows changed files with status badges and line counts
- navigate to an agentic process with workdir pointing to a git repo with at least one
  modified, added, deleted, or untracked file (e.g. the flow-cli repo itself has M files)
- open the Git panel
- validate at least one file row appears in the panel body
- validate each row contains a status badge (M=amber, A=green, D=red, ?=muted, R=blue)
- validate the file basename is shown in medium weight text
- validate the directory path is shown in muted smaller text when the file is in a subdirectory
- validate files with insertions show a green "+N" count
- validate files with deletions show a red "-N" count

test 5: Git tab closes via the × button in the tab strip
- navigate to an agentic process terminal with a git repo workdir
- open the Git panel (click GitBranch ribbon button) — side window appears
- validate the "Git" tab is visible in the tab strip
- click the × button inside the "Git" tab (aria-label="Close Git")
- validate the side window is no longer visible (w-80 border-l div gone — no tabs remain)

test 6: Opening multiple tabs: Git and Prompts coexist in the same side window
- navigate to an agentic process terminal
- click the GitBranch ribbon button → Git tab opens in side window
- click the MessageSquare (Prompts) ribbon button → Prompts tab added to the same side window
- validate both "Git" and "Prompts" tabs are visible in the tab strip simultaneously
- validate the Prompts panel is shown (it was the last one opened — it is active)
- click the "Git" tab label in the strip → Git panel becomes active; Prompts tab still present
- click × on Prompts tab → Prompts tab removed; Git tab and Git panel remain
- click × on Git tab → side window disappears entirely (no tabs left)

test 7: Git panel shows "Not a git repository" for non-git workdir
- navigate to an agentic process whose workdir is NOT a git repository
  (e.g. a process whose context_data.workdir is /tmp or a non-versioned folder)
- click the GitBranch ribbon button
- validate the side window opens with a "Git" tab
- validate the inner panel header shows "Not a git repo"
- validate the panel body shows "Not a git repository" message and an "Initialize git repo" button

test 8: Git button is absent for plain shell terminals (no agentic process)
- navigate to {APP_URL}/dock/shell/new_terminal and wait for the plain shell to load
  (do NOT click Start Claude — stay on the plain shell tab)
- validate the bottom ribbon (idle LED + icons) is NOT present in the DOM
- validate no GitBranch button exists in the active terminal panel
  (the ribbon only renders when an agentic process is attached to the shell)

test 9: Git panel auto-refreshes — new changes appear within 5 seconds
- navigate to an agentic process terminal pointing to a git repo
- open the Git panel, note the current file list
- in a separate terminal, make a filesystem change in the workdir
  (e.g. `touch /path/to/workdir/qa_test_file.txt`)
- wait up to 7 seconds (panel polls every 5s)
- validate the new file appears in the git panel with status "?" (untracked)
- clean up: remove the test file
- wait up to 7 seconds, validate the file disappears from the panel

test 10: Git panel API endpoint returns correct structure
- call GET /api/v1/graph/compute_node/{id}/git-status?workdir=/Users/shlom/Documents/dev/flow-cli
  (replace {id} with the compute_node entity ID from GET /api/v1/graph/compute_node)
- validate response status is 200 with ApiResponse shape: { status: "OK", data: {...} }
- validate data.branch is a non-empty string
- validate data.ahead is a number >= 0
- validate data.behind is a number >= 0
- validate data.files is an array
- validate each file entry has: status (string), path (string), insertions (number|null), deletions (number|null)
- validate data.error is null
- call the same endpoint with workdir=/tmp (non-git dir)
- validate data.error is set (e.g. "not a git repository") and data.files is []
