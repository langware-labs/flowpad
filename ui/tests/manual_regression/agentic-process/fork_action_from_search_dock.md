# Fork action from search dock-menu creates a visible, interactive PTY

## Preconditions
- Backend running at `http://localhost:9008`, frontend at `http://localhost:4098`.
- At least one `claude_session` record exists in the index (run a Claude session beforehand so it appears in search).

## URL
- Start at: `http://localhost:4098/`
- The action is triggered from the global search dock-menu on a `claude_session` result (not a fixed URL).

## Steps
1. Open the command/search palette (global search) and type a query that returns a `claude_session` result.
2. Right-click (or open the actions menu via the dock-menu affordance) on the `claude_session` row.
3. Click the `Fork` action (GitBranch icon).
4. Observe the dock navigating to the newly-created AgenticProcess shell tab.

## Expected result
- A new `AgenticProcess` is created with `workdir` equal to the source session's `cwd`.
- The create-process network payload includes `visible: true` (inspectable in DevTools Network tab — the `createProcess` call body should contain `{ visible: true, watchProcess: false }` in its options).
- The shell tab mounts an interactive xterm that accepts keyboard input (e.g. typing `echo hi` + Enter prints `hi`).
- No `[Fork] No compute node` error and no unresolved-promise / hung-shell state.

## Failure signature (pre-fix)
- Process is created with `visible: false`; the shell view loads but the PTY never attaches or the tab shows a non-interactive/blank terminal.
