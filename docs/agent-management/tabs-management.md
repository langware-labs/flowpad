---
id: bffe7b0a-f5a0-5ec2-b5a5-81061e1760f4
---

# Terminal Tabs Management

This document is the terminal-specific companion to
[`../tab-management.md`](../tab-management.md). The global tab architecture is
owned there: every visible chip in the content-panel strip is a backend `Tab`
entity, rendered through one frontend store and one `UnifiedTabStrip`.

The old terminal-only model is gone. Do not describe terminal membership as a
`Shell` query, `AgenticProcess.visible` query, `useActiveTerminals()`,
`TerminalTab`, `activeSessionId`, or a `TabbedTerminal`-owned strip. Those names
belong to historical docs only.

## Current Model

- `Tab` is the strip membership, label, order, project, and close/rename action
  target. A terminal tab is just a `Tab` whose `target_type` is `shell` or
  `agentic_process`.
- `Shell` is the PTY transport entity. Plain terminal tabs target `Shell`.
- `AgenticProcess` is the worker entity. Interactive worker tabs target
  `AgenticProcess` and resolve their transport shell through `shell_id`.
- `AgenticProcess.visible` still distinguishes interactive vs headless worker
  mode, but it is not the strip membership source.
- `UnifiedTabStrip` renders the chips. Active chip state is URL-first:
  `currentDock.tabHash`.
- `TabbedTerminal` renders terminal panels only. It filters terminal `Tab`s
  from the global tab store and warm-mounts an `InteractiveTerminal` per visited
  row.
- `dataContext.activeShellId` and
  `dataContext.activeTerminalTargetTypeId` are runtime context for PTY transport
  and process UI. They are not the tab-strip source of truth.

## Current Routes

Relevant files:

- `ui/src/routes/loaders/main-loader.ts`
- `ui/src/routes/loaders/load-shell.ts`
- `ui/src/routes/loaders/load-process.ts`
- `ui/src/routes/loaders/load-next-process.ts`
- `ui/src/navigation/DockPointer.ts`
- `ui/src/navigation/NavigationActions.ts`
- `ts_sdk/src/entities/tab.ts`

| Surface               | URL shape                                                | Loader behavior                                                                                                                                                                                                    |
| --------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Default terminal view | `/dock/shell`                                            | `loadShellRoute()` resolves a default terminal `Tab` with `loadNextProcess()` and redirects to a concrete shell/process pointer.                                                                                   |
| New plain terminal    | `/dock/shell/new_terminal`                               | Creates a new `Shell`, then replaces the URL with `/dock/shell/shell-<shellId>`; this redirect-only URL is not materialized as a persistent Tab.                                                                   |
| Plain shell tab       | `/dock/shell/shell-<shellId>` or `/dock/shell/<shellId>` | `setupTab(dock)` materializes the `Tab`, then `loadShell(shellId)` loads the Shell, resolves project/workdir, starts or reattaches the PTY, and clears process context.                                            |
| Worker terminal tab   | `/dock/shell/agentic_process-<processId>`                | `setupTab(dock)` materializes the `Tab`, then `loadProcess(processId)` loads the process, resolves project/workdir, calls `process.start({ visible: true })`, resolves the linked Shell, and sets process context. |
| Worker transcript     | `/dock/lens/<worker>/transcript/<sessionId>`             | Read-only transcript view. `AgenticProcess.dockPointer` defaults here once `session_id` is known; terminal-opening call sites must use `terminalDockPointer`.                                                      |

`ViewType.AGENTIC_PROCESS` still exists and `ContentPanel` has a
`ProcessTerminal` branch, but the normal interactive worker terminal route is
`/dock/shell/agentic_process-<processId>`.

## Tab Materialization

All dock routes pass through `loadAgentApp()`. For any valid dock whose
`DockPointer.toJSON()` is non-null, the loader calls:

```ts
await setupTab(dock, { setupContent });
```

On a cold landing the lifecycle wrapper first resolves/materializes the backend
`Tab` row through `Tab.getFromDockPointer(dock)`, then runs the route-specific
content setup. An already-open content-asset dock with the same tab identity skips
the list/new-tab round trip, reruns only content setup, and returns no new
`TabSetupResult.tab`; its existing backend row and lifecycle `tabId` remain
authoritative. For terminal docks setup is the existing shell/process FSM:

```text
loadShellRoute
  -> loadShell or loadProcess
  -> process.start({ visible: true }) for agentic processes
  -> process.shell() / PTY attach
  -> terminal body can render
```

The backend deduplicates by `pointer`, keeps global `tab_order`, and broadcasts
`tabs_changed`; `all-tabs-store` refreshes with `Tab.listAll()`. The frontend
lifecycle then marks the dock `opened`, or `open_failed` if setup fails after a
tab row exists. Failed tabs stay visible and closeable and render an in-content
error placeholder.

Terminal tabs therefore appear because the user navigated to a terminal dock,
not because `TabbedTerminal` inserted a row. `opened` means terminal content can
render; it is independent of worker status, busy/thinking states, and
ready-for-input glow.

## Terminal Body

`ui/src/components/terminal/TabbedTerminal.tsx` is the terminal body.

Props:

| Prop             | Description                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `className`      | Extra CSS class for the body wrapper.                                                                           |
| `scope`          | `'project'` shows terminal rows for the active project plus projectless rows; `'all'` shows every terminal row. |
| `spawnProjectId` | Optional project id used by the opener chrome when creating shells/processes.                                   |

Important behavior:

- Reads tabs through `useTerminalTabs()`, which filters the one global
  `Tab[]` list to `shell` and `agentic_process` targets.
- Active panel is URL-derived by comparing each row pointer with
  `currentDock.tabHash`.
- Panels lazy-mount on first activation and remain mounted with hidden inactive
  panels, preserving xterm state.
- A process panel hydrates its live `AgenticProcess`, then uses
  `process.shell_id` as the transport shell id.
- A plain shell panel uses the row target id as the transport shell id.
- PTY title changes save the live Shell/AgenticProcess when `auto_rename` is
  still true, then mirror the label to the Tab through `Tab.setNameById()`.

## Strip And Chrome

The chip strip is `UnifiedTabStrip`, not `TabbedTerminal`.

`useTerminalStripController()` owns only the terminal chrome around the shared
strip:

- opener toolbar and menu items for Claude, Codex, Copilot, plain terminal,
  sandbox, docker, resume-by-id, and history
- projects counter chip
- history/resume/install modals
- spawn locks and pending state

It does not own the tab list, active key, select, close, rename, or reorder
behavior. Those go through `UnifiedTabStrip` and `Tab` actions.

## Creating Terminal Tabs

### Worker tab

1. The opener calls `navigation.openNewClaudeProcess()` with the requested worker
   type and optional project/cwd.
2. The backend creates or upserts an `AgenticProcess`.
3. The UI navigates to `navigation.openShellProcess(processId)`.
4. `setupTab()` materializes the `Tab`.
5. `loadProcess()` starts or reattaches the worker PTY and resolves the linked
   Shell; lifecycle reaches `opened` once the terminal can render, not when the
   worker is ready for input.

There is no frontend command injection for `claude --session-id`,
`claude --resume`, Codex, or Copilot startup. Worker startup is server-side.

### Plain terminal tab

1. The opener calls `navigation.openNewShell({ skipNavigate: true, ... })`.
2. The backend creates a `Shell`.
3. The UI navigates to `navigation.openShell(shellId)`.
4. `setupTab()` materializes the `Tab`.
5. `loadShell()` starts or reattaches the PTY.

### Resume by worker session id

The resume flow uses `useResumeInTerminal()` /
`AgenticProcess.fromClaudeSession()` or the generic worker-session lookup. The
result is an `AgenticProcess`, and navigation goes to its terminal dock pointer.

## Closing And Renaming

All strip actions resolve a `Tab` and call the `tab` action by Tab id:

- close: `closeTabWithLifecycle(tab)` (runtime cleanup, then `Tab.closeById(tab.id)`)
- rename: `Tab.renameById(tab.id, name)`
- reorder: `Tab.reorder(tab.id, afterId, beforeId, projectId)`
- PTY auto-title mirror: `Tab.setNameById(tab.id, title)`

`Tab.close()` soft-hides the row (`visible=false`) and dispatches
`teardown_for_tab()` on the target when present. Shell and AgenticProcess own
their teardown semantics; content tabs generally do nothing on close.

User rename is different from PTY auto-title:

- user rename calls `Tab.renameById()`, updates `Tab.name`, reflects to the
  target entity, and Shell/AgenticProcess pin `auto_rename=false`;
- PTY auto-title calls `Tab.setNameById()`, updating only the chip label without
  pinning `auto_rename`.

## PTY Lifecycle

PTY-mode terminal rows are always rendered through a `Shell` transport.

- Plain shell row: `target_type === shell`, transport id is `target_id`.
- Worker row: `target_type === agentic_process`, transport id comes from the live
  process `shell_id`.

`loadShell()` and `loadProcess()` open or reattach the PTY before the terminal is
usable. `InteractiveTerminal` resolves the Shell, initializes xterm after it has
dimensions, replays persisted PTY chunks, subscribes to live output, sends input
only when connected, and resizes only for the active panel.

Sidecar shells are Shell entities but not strip tabs. They are owned by the
process UI and are not represented by a visible `Tab` unless explicitly opened as
a normal shell dock.

## Default And Recovery Selection

Pointer-less `/dock/shell` and recovery paths use `loadNextProcess()`.

The candidate list is built from terminal `Tab`s via `Tab.listAll()` and
`useTabs.ts` filtering, then `resolveNextTab()` applies:

1. pending intent
2. `Tab.last_active_at`
3. `tab_order`

Current caveat: terminal loaders still call `Shell.activate()` /
`AgenticProcess.activate()` instead of `Tab.activateById()`. Because
`resolveNextTab()` reads recency from `Tab.last_active_at`, recency is not
fully effective until that path is wired to the Tab row. In practice, pending
intent and `tab_order` dominate when Tab recency is null.

## Navigation Helpers

| Method                                  | Current meaning                                                                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `openShellView()`                       | Opens `/dock/shell`; loader chooses a default terminal tab.                                                                      |
| `openShell(shellId, options?)`          | Navigates to the shell terminal dock.                                                                                            |
| `openShellProcess(processId, options?)` | Navigates to `/dock/shell/agentic_process-<processId>`.                                                                          |
| `openWorkerSession(sessionId)`          | Resolves a worker/session/thread id and navigates to its terminal process when found.                                            |
| `openNewClaudeProcess(options?)`        | Creates a visible worker process and returns ids; caller navigates to the shell process route.                                   |
| `openNewShell(options?)`                | Creates a Shell; navigates unless `skipNavigate: true`.                                                                          |
| `openSession(shellId, options?)`        | Shell-aware terminal navigation: redirects to the owning process when the shell belongs to one, otherwise opens the plain shell. |
