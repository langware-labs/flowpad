# Tabs Management

This document describes the current terminal tab, routing, PTY, and live session model. The current implementation is entity driven:

- `Shell` is the persisted terminal/PTY entity.
- `AgenticProcess` is the Claude/agentic worker entity. Interactive workers link to a `Shell` through `shell_id`.
- `TabbedTerminal` renders tabs from `Shell` and visible `AgenticProcess` entities. It does not own the active tab id directly.
- Shell and process route loaders open or reattach PTYs and then write active IDs into `dataContext`.

The older `ShellManager`, `ShellSession`, `useShellSessions`, `startClaude`, and `resumeClaude` URL model is no longer the source of truth for these tabs.

---

## Current Routes

Relevant files:

- `ui/src/routes/loaders/main-loader.ts`
- `ui/src/routes/loaders/load-shell.ts`
- `ui/src/routes/loaders/load-process.ts`
- `ui/src/navigation/NavigationActions.ts`
- `ui/src/navigation/DockPointer.ts`
- `ts_sdk/src/utils/ui/view-types.ts`

| Surface | Current URL shape | Loader/action behavior |
|---------|-------------------|------------------------|
| Default terminal view | `/dock/shell` | `loadShellRoute()` resolves a default visible tab, preferring `dataContext.activeShellId`, then redirects to a concrete shell/process pointer. |
| New plain terminal | `/dock/shell/new_terminal` | Creates a new `Shell`, then redirects to `/dock/shell/shell-<shellId>`. |
| Plain shell tab | `/dock/shell/shell-<shellId>` or `/dock/shell/<shellId>` | `loadShell(shellId)` starts or reattaches the `Shell` PTY and clears current process context. |
| Claude/agentic terminal tab | `/dock/shell/agentic_process-<processId>` | `loadProcess(processId)` calls `process.start({ visible: true })`, resolves the linked `Shell`, and sets process and shell context. |
| Live session viewer | `/dock/session/<processId>` | `main-loader.ts` sets `CurrentProcessTypeId`, active entity id, project context, and compute node. It does not open a PTY by itself. |

`AgenticProcess.dockPointer` currently returns a `ViewType.SHELL` pointer, so the standard terminal route for an agentic process is `/dock/shell/agentic_process-<processId>`. Do not document `/dock/agentic_process/:processId` as the normal terminal tab route, even though `ViewType.AGENTIC_PROCESS` still exists and `ContentPanel` has a `ProcessTerminal` branch for that view.

There are no `startClaude` or `resumeClaude` route params in the current loader path. Creating or resuming Claude sessions is done by creating/upserting an `AgenticProcess` entity and then navigating to that entity's dock pointer.

---

## TabbedTerminal

**File:** `ui/src/components/terminal/TabbedTerminal.tsx`

`TabbedTerminal` is a mostly dumb terminal tab strip. It renders the tab list, creates/renames/closes tab entities, and delegates navigation decisions to callbacks supplied by its consumer.

### Props

| Prop | Type | Description |
|------|------|-------------|
| `className` | `string` | Extra CSS class for the root element. |
| `addTabButton` | `boolean` | Shows the opener toolbar for Claude, plain terminal, sandbox, docker, resume-by-id, and history flows. |
| `collaborationRoomId` | `string \| null` | Limits tabs to shells shared into a collaboration room. |
| `spawnProjectId` | `string \| null` | Pins newly created shells/processes to a project id instead of relying on current global project context. |
| `onTabClick` | `(shellId, session) => void` | Called when the user selects a tab. The consumer navigates. |
| `onTabClose` | `(shellId) => void` | Called after the backend close action is committed. The consumer chooses the next route. |
| `onTabOpen` | `(session) => void` | Called after a new shell/process entity is created. The consumer navigates. |

Removed props from older docs: `activeSessionId`, `onActiveSessionChange`, `startClaude`, `resumeClaude`, `claudeTargetSession`, `claudeCwd`, and `startCommand`.

### Tab Data

**File:** `ui/src/hooks/useActiveTerminals.ts`

`TabbedTerminal` reads tabs from `useActiveTerminals()`, which queries:

- `Shell` entities where `status != closed`.
- `AgenticProcess` entities where `visible: true`.

`filterTabs()` builds `TerminalTab[]` by:

- Filtering out `ShellStatus.ERROR` shells for the visible tab strip.
- Filtering out sidecar shells referenced by `AgenticProcess.sidecar_shell_id`.
- Optionally filtering by `Shell.collaboration_room_id`.
- Marking tabs with `ShellStatus.CLOSING` or `ShellStatus.CLOSED` as disabled.
- Linking currently active processes to tabs through `AgenticProcess.shell_id`.
- Sorting tabs by `Shell.tab_order`.

Current tab shape:

```ts
type TerminalTabType = 'plain' | 'claude';

interface TerminalTab {
  shellId: string;
  tabOrder: number;
  name: string | null;
  type: TerminalTabType;
  agenticProcess?: AgenticProcess;
  shell?: Shell;
  isDisabled: boolean;
  statusReason: string;
}
```

### Active Tab

The active shell comes from `dataContext.activeShellId`, which the route loader sets after a shell or process loads. `TabbedTerminal` falls back to the first visible tab only when context has no active shell yet.

On tab click, `TabbedTerminal` immediately writes `dataContext.setActiveShellId(shellId)` for fast visual switching, then calls `onTabClick`. The standard consumer wiring is `ui/src/components/terminal/useStandardTabNav.ts`, which navigates to either `session.agenticProcess.dockPointer` or `session.shell.dockPointer`.

### Creating Tabs

**Claude/agentic process tab:**

1. `handleStartClaude()` calls `navigation.openNewClaudeProcess()`.
2. `openNewClaudeProcess()` calls `computeNode.createProcess(..., { watchProcess: false, visible: true })`.
3. `TabbedTerminal` emits `onTabOpen()` with the new process and shell ids.
4. The consumer navigates to the process dock pointer.
5. `loadProcess()` calls `process.start({ visible: true })`; the backend builds the Claude command, opens or reopens the Shell-owned PTY, and returns the linked shell.

There is no frontend injection of `claude --session-id ...` or `claude --resume ...`.

**Plain terminal tab:**

1. `startTerminalTab()` calls `navigation.openNewShell({ skipNavigate: true })`.
2. `openNewShell()` creates a `Shell` with the next `Tab N` name, workdir, compute node id, and optional project id.
3. `TabbedTerminal` emits `onTabOpen()`.
4. The consumer navigates to the shell dock pointer.
5. `loadShell()` calls `shell.start()` to open or reattach the PTY.

**Resume Claude by session id:**

- The resume dialog in `TabbedTerminal` uses `useResumeInTerminal()`.
- `useResumeInTerminal()` calls `AgenticProcess.fromClaudeSession(sessionId)`.
- `fromClaudeSession()` calls `computeNode.upsertSessionProcess(sessionId, ...)`, resolving workdir from the Claude session record when possible.
- Navigation goes to the returned process dock pointer.

### Closing Tabs

`closeTab(shellId)` resolves the current tab from the `useActiveTerminals()` result.

- If the tab is the active shell and the current context has an `AgenticProcess`, it calls `AgenticProcess.close()`.
- Otherwise, if the tab has a `Shell`, it calls `Shell.close()`.
- After the backend action, `onTabClose(shellId)` is emitted.

The context menu supports Rename, New Claude Session, New Terminal, Close, Close All, Close All But This, and Close to the Right.

### Renaming Tabs

Double-clicking a tab name starts inline edit mode. A user rename calls `shell.updateDisplay({ name })`.

For the active Claude tab, a user rename also sends `/rename <name>\r` into the PTY only when `isReadyForInput(contextAgenticProcess)` is true. PTY title-change renames are treated separately and do not inject `/rename`; they also do not override backend `user_renamed` shells.

### Mounting and Scroll Behavior

Tabs are horizontally scrollable with left/right controls when the tab strip overflows.

Terminal panels are lazy-mounted:

- Only the active tab is mounted initially.
- A tab is added to `mountedShellIds` the first time it becomes active.
- Mounted terminals stay mounted and inactive ones are hidden with `visibility: hidden`.
- Unvisited tabs render no `InteractiveTerminal` tree yet.

This preserves xterm state after a tab has been visited without eagerly creating xterm instances for every open tab.

---

## Shell and PTY Lifecycle

**File:** `ts_sdk/src/entities/shell.ts`

`Shell` is the current terminal/PTY entity. It replaces the old frontend `ShellSession` documentation for tab behavior.

Important fields:

| Field | Description |
|-------|-------------|
| `id` | Shell entity id. The URL pointer is usually `shell-<id>`. |
| `name` | Tab display name. |
| `status` | `idle`, `running`, `closing`, `closed`, or `error`. |
| `workdir` | Working directory used when opening the shell. |
| `pty_pid` | Backend PTY handle returned by `Shell.start()` or `AgenticProcess.start()`. |
| `compute_node_id` / `compute_node_uname` | Compute node hosting the shell. Sandbox tabs are identified by `compute_node_uname === 'sandbox'`. |
| `project_id` | Project association used by route/context resolution. |
| `collaboration_room_id` | Collaboration-room filter key. |
| `tab_order` | Ordering key used by the terminal tab strip. |
| `claude_session_id` | Claude session id when known for a shell. |

`Shell` owns a `PtyConnection` instance. PTY lifecycle methods are:

- `start(opts)`: calls backend `shell/open`, updates shell fields, stores `pty_pid`, then calls `attachPty()`.
- `attachPty(opts)`: attaches the frontend PTY client to a backend PTY id. It is gated until the shell has been active at least once.
- `sendInput(data)`: sends raw PTY input.
- `resize(cols, rows)`: resizes the backend PTY.
- `close()`: calls backend `shell/close`, disposes the frontend PTY client, and marks the shell closed.
- `fetchPtySequence()`: fetches persisted PTY chunks for replay.

### PTY-Mode Tab Behavior

PTY-mode tabs are all backed by a `Shell`, whether they are plain terminals or visible Claude/agentic process terminals.

Current behavior:

- Route loaders open or reattach the PTY before the tab is considered active.
- `InteractiveTerminal` resolves the `Shell` with `useShell(sessionId)`.
- xterm initializes only after the panel has dimensions.
- On shell `connected`, `InteractiveTerminal` resets xterm, replays `shell.getPtyChunks()`, then subscribes to live output with `shell.onOutput()`.
- Incoming output is processed through `PtySyncSession` so trace gutters, annotations, and scroll sync share the same replayed stream.
- Keyboard input is sent only when `shell.connected` is true.
- Resize events run only for the active tab and call `shell.resize()`.
- Page refresh or websocket reconnect reattaches through `Shell.start()` / `Shell.attachPty()` and replays stored chunks.

Sidecar shells are also `Shell` entities, but they are not main terminal tabs. `InteractiveTerminal` creates a sidecar shell in `process.sidecar_shell_id` for the optional shell pane, and `useActiveTerminals()` excludes those shell ids from the main tab strip.

---

## AgenticProcess Startup and Worker Modes

**Files:**

- `ts_sdk/src/process/agentic-process.ts`
- `ts_sdk/src/process/agentic-context.ts`
- `ts_sdk/src/process/agentic-types.ts`
- `ui/src/routes/loaders/load-process.ts`

`AgenticProcess.start()` is the current interactive startup primitive. It calls backend action `agentic_process/open`, which handles fresh starts, reopens, and Claude session resumes server-side. The result includes `shell_id`, `pty_id`, `session_id`, and a serialized shell. The SDK updates the process, materializes the shell, and attaches the shell PTY.

`loadProcess(processId)` is the route primitive for `/dock/shell/agentic_process-<processId>`:

1. Load the process cache-first.
2. Call `process.start({ visible: true })`.
3. Resolve `process.shell()`.
4. Set `dataContext.activeShellId`.
5. Set workdir and current process/project context.

### CLI / Headless Mode

`WorkerMode` is derived from `AgenticProcess.visible`:

- `visible === true`: `WorkerMode.Interactive`, represented by a `Shell` PTY and xterm in the terminal tab strip.
- `visible === false`: `WorkerMode.CLI`, represented as a headless/print-mode `AgenticProcess` without a terminal tab.

Headless processes are created with `AgenticProcess.spawn(..., { headless: true })`. In that path, the SDK calls `process.watch()` and optionally `process.executeInstruction()` instead of `process.start()`, so no shell PTY is opened.

Headless/CLI work is represented by the `AgenticProcess` entity, FlowData/history, and any surface that explicitly queries that process. It is not represented as a `TabbedTerminal` tab unless the process is later opened interactively and linked to a `Shell`. The terminal tab strip is built from shell rows, so a process with no `shell_id` has no PTY tab.

For print-mode processes, `AgenticProcess.prompt()` posts to the `prompt` action and streams FlowData over HTTP. PTY-interactive processes use the shell-backed `start()`/`executeInstruction()`/input path instead.

---

## InteractiveTerminal

**Files:**

- `ui/src/components/terminal/interactive-terminal/InteractiveTerminal.tsx`
- `ui/src/hooks/useShell.ts`

`InteractiveTerminal` is the xterm/PTYSYNC renderer for a single shell id.

Key inputs:

| Prop | Description |
|------|-------------|
| `sessionId` | Shell id to render. |
| `active` | Whether this terminal is currently visible and should resize/focus. |
| `process` | Optional explicit `AgenticProcess`. If omitted, it uses the context process set by the loader. |
| `embedded` / `onClose` | Embedded toolbar behavior for non-tab placements. |
| `onWorkerSessionId` | Emits the process worker session id when known. |

Important behavior:

- Uses `useShell(sessionId)` to resolve the shell entity and reactive connection state.
- Uses `PtySyncSession`, `XTermHarness`, trace gutters, time gutters, and annotation gutters around the xterm buffer.
- Reads URL query `t` as an optional timestamp target for annotation/scroll behavior.
- For active process tabs, displays process-specific UI such as `ProcessToolbar`, side windows, input files, queue, trace, and sidecar shell controls.
- Falls back to `contextProcess` when `TabbedTerminal` does not pass a process prop; this is why `loadProcess()` must set process context for the active agentic tab.

---

## SessionViewer

**File:** `ui/src/components/live-workflow/SessionViewer.tsx`

`SessionViewer` is the live conversation/FlowData view rendered at `/dock/session/:processId`. It is separate from the PTY terminal tab strip.

Layout:

```text
SessionTabBar
RunningArea
InterferenceBox
```

### Session Tabs

Session tabs are process tabs:

```ts
interface SessionTab {
  id: string;                  // AgenticProcess id
  name: string;
  favorite_index?: number | null;
}
```

On mount, `SessionViewer` queries up to 100 visible `AgenticProcess` entities scoped to the current project, ordered by `updated_at desc`. A module-level `sessionTabsCache` stores tabs per project id for the current browser session.

Display names are resolved in this order:

1. `process.context_data.display_name`
2. First 30 characters of `process.instruction_content` after stripping comments
3. Fallback such as `Session 3`

### favorite_index

`favorite_index` is persisted on the `AgenticProcess` via `PUT /api/v1/graph/agentic_process/:id` and controls left-to-right tab order.

- If no tabs have `favorite_index`, fetched tabs keep `updated_at desc` order.
- Once any tab has `favorite_index`, tabs sort by that value ascending, with `null` last.
- New tabs get `favoriteMaxRef.current + 1000`.
- Drag reorder assigns a midpoint between neighbors when possible.
- Closing a tab sets `favorite_index: null` and `visible: false`.

### SessionViewer Actions

| Action | Current behavior |
|--------|------------------|
| Select tab | Sets `activeTabId`, persists `visible: true`, then calls `navigation.openShellProcess(processId)`. This navigates to the process terminal route, not just an in-place SessionViewer switch. |
| Close tab | Removes the process id from local/cache state, persists `favorite_index: null` and `visible: false`. If closing the active process, current code calls `navigation.openSession(remaining[0].id)` for the first remaining id or `navigation.openShellView()` when none remain. |
| Add tab | Calls `computeNode.createProcess({ projectId, workdir }, { visible: true })`, persists the next `favorite_index`, and opens the process terminal. |
| Rename tab | Writes `context_data.display_name` on the `AgenticProcess` and saves it. |
| Inject instruction | Calls `process.executeInstruction(content, { sync: false })` through `useSessionProcess()`. |

`SessionActionButtons` exposes "Resume in terminal" when `process.session_id` is known. It uses `useResumeInTerminal()`, not a `resumeClaude` URL flag.

---

## Navigation Helpers

**File:** `ui/src/navigation/NavigationActions.ts`

Terminal-related helpers currently mean:

| Method | Current meaning |
|--------|-----------------|
| `openShellView()` | Opens `/dock/shell` and lets `loadShellRoute()` choose the default tab. |
| `openShell(shellId, options?)` | Loads a `Shell` entity and navigates to `shell.dockPointer`. No Claude start/resume flags are used. |
| `openShellProcess(processId, options?)` | Loads an `AgenticProcess` and navigates to `process.dockPointer`, which is currently a `ViewType.SHELL` pointer. Supports terminal query hints such as `t`, `windows`, and `activeWindow`. |
| `openProcessTab(processId, options?)` | Equivalent process-tab navigation through the process dock pointer. |
| `openShellTab(shellId)` | Opens a plain shell dock pointer. |
| `openClaudeSession(sessionId)` | Upserts an `AgenticProcess` for a Claude session id and navigates to its dock pointer. |
| `openNewClaudeProcess(options?)` | Creates a visible process and returns ids; `TabbedTerminal` handles navigation through `onTabOpen`. |
| `openNewShell(options?)` | Creates a `Shell`; navigates unless `skipNavigate: true`. |
| `openSession(shellId, options?)` | Despite the name, this is shell-aware terminal navigation: it looks for a process whose `shell_id` matches, otherwise opens the plain shell. It is not the `/dock/session/:processId` SessionViewer helper. |

`DockPointer.forSession(processId)` exists for `ViewType.SESSION`, but `NavigationActions` does not currently expose a dedicated wrapper for it.
