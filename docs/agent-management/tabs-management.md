# Tabs Management

This document covers the tab and session management system used across the terminal and live workflow views. It includes the `TabbedTerminal` component, the `ViewType` enum, the `ShellManager` service, the `useShellSessions` hook (and related hooks), and the `SessionViewer` component with its `favorite_index` ordering mechanism. Navigation actions for opening shell and session views are covered at the end.

---

## TabbedTerminal

**File:** `ui/src/components/terminal/TabbedTerminal.tsx`

`TabbedTerminal` is a controlled, multi-tab terminal interface. Each tab corresponds to one `ShellSession` (a PTY session). The parent component owns the active tab identity; `TabbedTerminal` reports changes upward via a callback.

### Props

| Prop | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `activeSessionId` | `string` | yes | — | ID of the currently visible session. |
| `onActiveSessionChange` | `(sessionId: string) => void` | yes | — | Called whenever the active tab should change. |
| `className` | `string` | no | `''` | Extra CSS class applied to the root element. |
| `addTabButton` | `boolean` | no | `false` | When true, renders a `+` button that creates a plain terminal tab. |
| `startClaude` | `boolean` | no | — | When true, the component creates a session and injects `claude --session-id <id>` into it on mount. |
| `resumeClaude` | `boolean` | no | — | When true, injects `claude --resume <id>` instead. |
| `claudeTargetSession` | `string` | no | — | The specific session ID that Claude should start in (read from URL to avoid race conditions with React state). |
| `claudeCwd` | `string` | no | — | Working directory passed to `startPty` as `working_dir`. |
| `startCommand` | `string` | no | — | Custom command to send instead of the default `claude --session-id` string. Takes highest precedence when all three of `startClaude`, `resumeClaude`, and `startCommand` are provided. |
| `skipPermissions` | `boolean` | no | — | When true, renders a "Full Trust Mode" amber banner above the tab bar. |
| `process` | `AgenticProcess` | no | — | When provided, the matching `InteractiveTerminal` (by `process.pty_pid`) receives the process entity, enabling `ProcessToolbar` rendering. |

### Internal State

| State | Type | Purpose |
|-------|------|---------|
| `editingSessionId` | `string \| null` | ID of the tab whose name is currently being edited inline. |
| `editingName` | `string` | Controlled input value while renaming a tab. |
| `canScrollLeft` | `boolean` | Whether the tab bar can scroll further left. |
| `canScrollRight` | `boolean` | Whether the tab bar can scroll further right. |
| `claudeCommandSentRef` | `React.MutableRefObject<string \| null>` | Tracks the session ID for which the Claude CLI command was already sent, preventing React StrictMode double-fires. |

### Session List

The component calls `useShellSessions()` to get a reactive, always-up-to-date list of all sessions from `ShellManager`. It applies no additional filtering — every session in the manager is shown as a tab.

### Creating Tabs

**Plain terminal tab (`handleAddTab`):**
1. Generates a session ID as `shell-${Date.now()}`.
2. Finds the first unused "Terminal N" number across existing sessions.
3. Calls `shellManager.createSession(sessionId, name, true)` (the `true` flag marks it as a PTY session).
4. Calls `onActiveSessionChange(sessionId)` to make the new tab active.

**Claude CLI tab (`startClaude` / `resumeClaude` flow):**
1. Triggered by a `useEffect` that depends on `startClaude`, `resumeClaude`, `claudeTargetSession`, and related props.
2. If resuming and the session already has a started PTY, the old session is removed first to avoid injecting into a stale terminal.
3. `shellManager.createSession(claudeTargetSession, 'Claude CLI', true)` is called if the session does not yet exist.
4. `session.workingDir` and `session.initialCommand` are set; `InteractiveTerminal` reads these when it starts the PTY so the backend can detect the shell prompt and inject the command reliably.

**"Start Claude" button:**
Always opens a new shell-process view (`navigation.openShellProcess('new')`), delegating entity creation to the routing layer.

### Closing Tabs

| Action | Behaviour |
|--------|-----------|
| `handleCloseTab(sessionId)` | Removes session from `ShellManager`. If the closed tab was active, switches to the nearest remaining tab (by index) or emits `''`. |
| `handleCloseAll()` | Removes all sessions; emits `''` for active session. |
| `handleCloseAllButThis(sessionId)` | Removes every session except the given one; sets that one as active. |
| `handleCloseToTheRight(sessionId)` | Removes all sessions after the given position. If the active session was in the removed range, switches to the boundary tab. |

All four actions are available from the right-click context menu on each tab. The context menu also exposes "Rename" which enters inline editing mode.

### Renaming Tabs

Double-clicking a tab name enters inline editing mode (`editingSessionId`, `editingName`). Pressing Enter or blurring the input calls `shellManager.updateSessionName(sessionId, name)`, which persists the name to the backend. Pressing Escape cancels without saving.

### Tab Scrolling

When the tab container overflows horizontally, `ChevronLeft` and `ChevronRight` buttons appear. Each click scrolls the container by 200 px. Scroll state (`canScrollLeft`, `canScrollRight`) is recalculated on scroll events, resize events, and whenever the session list changes.

### Terminal Panels

All terminal panels are kept mounted simultaneously. The currently active panel is shown with `display: block`; all others use `display: none`. This preserves xterm.js state across tab switches without unmounting. Each panel renders `<InteractiveTerminal sessionId={...} active={isActive} ... />`.

### Usage Example

```tsx
const [activeSessionId, setActiveSessionId] = useState('');

<TabbedTerminal
  activeSessionId={activeSessionId}
  onActiveSessionChange={setActiveSessionId}
  addTabButton
  startClaude
  claudeTargetSession="abc-123"
  claudeCwd="/home/user/project"
/>
```

---

## ViewType Enum

**File:** `ts_sdk/src/utils/ui/view-types.ts`

`ViewType` identifies which content panel view is currently open in the dock. It is used by navigation actions, URL builders, and dock state management.

### Values

| Value | String | Description |
|-------|--------|-------------|
| `HOME` | `'home'` | Home / landing page with a link to the system profile. |
| `SYSTEM_PROFILE` | `'system_profile'` | System profile showing Claude Code live status. |
| `ANALYSIS` | `'analysis'` | Session analysis overview. |
| `CHAT` | `'chat'` | Chat interface. |
| `SHELL` | `'shell'` | Interactive PTY terminal view. URL: `/dock/shell/:sessionId`. |
| `EDITOR` | `'editor'` | Code editor. |
| `WEB_APP` | `'web-app'` | Embedded web application (port viewer). |
| `ENVIRONMENT` | `'environment'` | Environment variable viewer. |
| `CONNECTIONS` | `'connections'` | Connection management. |
| `ARTIFACTS` | `'artifacts'` | Artifacts / results viewer. |
| `REASONING` | `'reasoning'` | Reasoning / thought process viewer. |
| `DIFF` | `'diff'` | Git diff / checkpoint viewer. |
| `UNSUPPORTED` | `'unsupported'` | Fallback viewer for unrecognised view types. |
| `MARKDOWN` | `'markdown'` | Markdown renderer. |
| `DOCS` | `'docs'` | Documentation viewer (`.md` files). |
| `ASSISTANCE` | `'assistance'` | Expert assistance task view. |
| `SURVEY` | `'survey'` | Survey view. |
| `API_KEYS` | `'api-keys'` | API key management. |
| `HOOKS` | `'hooks'` | Claude Code hooks configuration. |
| `MACHINE` | `'machine'` | Machine overview (processes, network). |
| `EXPLORER` | `'explorer'` | File explorer. |
| `SKILLS` | `'skills'` | Claude Code skills editor. |
| `AI_CONFIG` | `'ai-config'` | AI configuration (LLM APIs, CLIs). |
| `EXECUTE_FLOW` | `'execute-flow'` | Execute markdown instruction files. |
| `SHOW` | `'show'` | MCP UI display dock pointer. |
| `LENS` | `'lens'` | Lens viewer for specialised content (e.g., transcripts). |
| `SESSION` | `'session'` | Live session view — `SessionViewer` component. URL: `/dock/session/:processId`. |
| `TASKS` | `'tasks'` | Task create / edit view. |
| `SETTINGS` | `'settings'` | Claude Code settings viewer. |
| `AGENTIC_PROCESS` | `'agentic_process'` | Process terminal view (Layer 3). URL: `/dock/agentic_process/:processId`. |

### Related Enums

`view-types.ts` also exports:

- **`Layout`** (`'dock'` | `'dev'`) — selects the outer layout system.
- **`WebappSubview`** — sub-navigation within the `WEB_APP` view (`webapp-shell`, `webapp-artifacts`).
- **`MachineSubview`** — sub-navigation within the `MACHINE` view (`processes`, `network`, `gateway`, `metrics`, `logs`).
- **`AIConfigSubview`** — sub-navigation within the `AI_CONFIG` view (`llm-apis`, `clis`).

---

## ShellManager

**File:** `ts_sdk/src/services/shell/shellManager.ts`

`ShellManager` is the singleton coordinator for all shell sessions. It does not own sessions directly; sessions are owned by the active `ComputeNode`. `ShellManager` delegates every session operation to that node, routes PTY output from the WebSocket layer to the correct session, and emits events so the React UI can re-render.

The singleton is exported as `shellManager` (a pre-constructed instance). It is also exposed as `window.shell` for browser-console debugging.

### Session Ownership Model

```
WebSocket (ConnectionManager) → ShellManager (routes PTY output)
                                     ↓
                              activeNode (ComputeNode)
                                     ↓
                            node.sessions (Map<sessionId, ShellSession>)
```

When the active node changes, the frontend session cache is cleared and re-synced from the backend. Backend PTYs are not closed by a node change.

### ShellManagerEvent

| Event | Emitted When |
|-------|-------------|
| `SESSION_CREATED` | A new session is added to the active node. Payload: `ShellSession`. |
| `SESSION_REMOVED` | A session is removed. Payload: `sessionId: string`. |
| `SESSION_UPDATED` | A session property changes (name, PTY state, etc.). Payload: `ShellSession` (optional). |
| `COMMAND_STARTED` | A non-PTY command begins executing. Payload: `{ sessionId, commandId, command }`. |
| `COMMAND_COMPLETED` | A non-PTY command finishes. Payload: `{ sessionId, commandId, result, error? }`. |
| `COMMAND_OUTPUT` | A delta of stdout/stderr arrives during command execution. Payload: `{ sessionId, commandId, stream, content }`. |
| `PTY_STARTED` | A PTY backend session becomes active. Payload: `{ sessionId, computeNodeId, cols, rows }`. |
| `PTY_CLOSED` | A PTY session is closed. Payload: `{ sessionId }`. |
| `PTY_OUTPUT` | PTY output was routed to a session. Payload: `{ sessionId, data, seq }`. For logging only; UI subscribes to session-level `onPtyData`. |
| `PTY_RESIZED` | PTY dimensions changed. Payload: `{ sessionId, cols, rows }`. |
| `PTY_ERROR` | A PTY operation failed. Payload: `{ sessionId, error }`. |
| `NODE_CHANGED` | The active `ComputeNode` changed. Payload: `{ previousNode, newNode }`. |

### Key Methods

#### Node Management

| Method | Signature | Description |
|--------|-----------|-------------|
| `setActiveNode` | `(node: ComputeNode \| null): Promise<void>` | Sets the active compute node. Clears the local session cache, starts a new backend sync, and begins watching machine sessions over WebSocket. Increments `nodeGeneration` to invalidate stale async work. |
| `getActiveNode` | `(): ComputeNode \| null` | Returns the current active node. |
| `hasActiveNode` | `(): boolean` | Returns true if a node is set. |
| `getNodeGeneration` | `(): number` | Returns the current generation counter. |

#### Session CRUD

| Method | Signature | Description |
|--------|-----------|-------------|
| `createSession` | `(sessionId: string, name: string, isPty?: boolean): Promise<ShellSession \| null>` | Delegates to the active node. Flushes any buffered PTY output after creation. Emits `SESSION_CREATED`. |
| `removeSession` | `(sessionId: string): boolean` | Closes the backend PTY (if started) then removes the session from the node cache. Cleans up the per-session `TextDecoder`. Emits `SESSION_REMOVED`. |
| `getSession` | `(sessionId: string): ShellSession \| undefined` | Looks up a session by ID on the active node. |
| `getAllSessions` | `(): ShellSession[]` | Returns all sessions from the active node (in creation order). |
| `hasSession` | `(sessionId: string): boolean` | Returns true if the session exists on the active node. |
| `updateSessionName` | `(sessionId: string, name: string): boolean` | Updates the session's name in memory, emits `SESSION_UPDATED`, and persists the new name to the backend via the `terminal-command/rename` action over WebSocket. |
| `isShellReady` | `(sessionId: string): boolean` | Returns true if the session exists, is a PTY, and `ptyStarted` is true. |
| `sessionCount` | `number` (getter) | Number of sessions on the active node. |

#### PTY Lifecycle

| Method | Signature | Description |
|--------|-----------|-------------|
| `startPty` | `(sessionId, cols, rows, computeNode?, workingDir?): Promise<void>` | Sends the `terminal-command/start` action to the backend. Sets `session.computeNodeId`, marks `ptyStarted = true`, and emits `PTY_STARTED`. Passes `initial_command` if set on the session object. Idempotent if the PTY is already started. |
| `sendPtyInput` | `(sessionId, data, computeNode?): Promise<void>` | Sends raw input bytes to the backend PTY via `terminal-command/input`. The data string is passed as-is (the `\r` suffix is added by the caller). |
| `resizePty` | `(sessionId, cols, rows): Promise<void>` | Sends `terminal-command/resize` to the backend. Emits `PTY_RESIZED`. |
| `closePty` | `(sessionId): Promise<void>` | Sends `terminal-command/close`. Resets `ptyStarted = false` and removes the decoder. Emits `PTY_CLOSED` and `SESSION_UPDATED`. Called automatically by `removeSession` for PTY sessions. |
| `reattachSessionFromServer` | `(sessionId, since_seq?): Promise<number \| undefined>` | Sends `terminal-command/attach` with a sequence number. Used during backend sync to replay missed PTY output. Returns `latest_seq`. |

#### Command Execution (Non-PTY)

| Method | Signature | Description |
|--------|-----------|-------------|
| `executeCommand` | `(command, sessionId, computeNode?): Promise<FlowDataStream>` | For PTY sessions: sends input via `sendPtyInput` and returns an empty stream. For non-PTY sessions: executes via `computeNode.executeCommandStreaming`, populates the command substream with stdout/stderr/exit-code `FlowData` elements, and returns the completed substream. |
| `addCommandStream` | `(sessionId, cmdId, input): void` | Adds a new `FlowDataStream` substream for a command to the session's top-level stream. |
| `appendToCommandStream` | `(sessionId, cmdId, flowData): void` | Appends a `FlowData` element to an existing command substream. |
| `clearStream` / `clearLog` | `(sessionId): void` | Clears all substreams and items from the session's stream. `clearLog` is an alias. |

#### Backend Sync

| Method | Signature | Description |
|--------|-----------|-------------|
| `syncSessionsWithBackend` | `(node, generation): Promise<void>` | Lists active PTY sessions from the backend, creates any that are missing locally, and optionally replays history (only for sessions that were already active before the sync). Guarded by `generation` checks to discard stale results from a previous node. |
| `syncSessionsWithBackendOnce` | `(node, generation): Promise<void>` | Calls `syncSessionsWithBackend` if a sync is not already in progress. |
| `isInitialSyncCompleted` | `(): boolean` | True once the first backend sync has finished. Used by routing logic to defer default session selection. |
| `flushPtyBuffer` | `(sessionId): void` | Delivers any PTY output that arrived before the session was available in the local cache. |

#### PTY Output Routing

`ShellManager` registers a single listener on `ConnectionManager` for `on_pty_output_msg` events. For each message:

1. Validates `message_type === 'pty_output_msg'` and a non-empty `session_id`.
2. Decodes the base64-encoded payload to UTF-8 using a per-session `TextDecoder` with `{ stream: true }`, which preserves incomplete multi-byte sequences (e.g., box-drawing characters) across message boundaries.
3. Looks up the session on the active node. If the session is not yet available, the output is buffered in `ptyOrphanBuffer`.
4. If available, calls `session.appendPtyOutput(decoded, seq)` which notifies xterm.js instances.

The orphan buffer is bounded: 200 chunks per session and 5 MB total across all sessions. Entries older than 30 seconds are skipped when flushing.

### ShellSession

**File:** `ts_sdk/src/services/shell/shellSession.ts`

`ShellSession` is the data object that `ShellManager` and `ComputeNode` operate on.

| Property | Type | Description |
|----------|------|-------------|
| `sessionId` | `string` | Unique session identifier. |
| `name` | `string` | Display name (shown in tab). |
| `stream` | `FlowDataStream` | Top-level command history stream. |
| `createdAt` | `number` | Unix timestamp (ms) of creation. |
| `isRunning` | `boolean` | True while a non-PTY command is executing. |
| `isPty` | `boolean` | True if the session is a PTY session. |
| `ptyStarted` | `boolean` | True once the backend PTY is active. |
| `computeNodeId` | `string?` | ID of the `ComputeNode` hosting the PTY. |
| `terminalId` | `string?` | UUID for the xterm.js instance. |
| `lastSeqReceived` | `number` | Last PTY output sequence number (for replay deduplication). |
| `workingDir` | `string?` | Working directory passed to the backend at PTY start. |
| `initialCommand` | `string?` | Shell command injected after the prompt is detected by the backend. |
| `processId` | `string?` | `AgenticProcess` ID that owns this PTY session. |

Key methods: `onPtyData(listener)` / `offPtyData(listener)` — subscribe / unsubscribe from decoded PTY output. `appendPtyOutput(data, seq)` — called by `ShellManager`; deduplicates by sequence number and dispatches to all listeners. `setPtyStarted(started, computeNodeId?)` — updates PTY state. `clearHistory()` — clears all substreams. `loadPersistence(sessionId)` / `clearPersistence(sessionId)` — static helpers for localStorage-based PTY state persistence across page refreshes.

---

## useShellSessions Hook

**File:** `ui/src/hooks/use-shell.ts`

`useShellSessions` is the lightest hook for reading the session list reactively. `TabbedTerminal` uses it exclusively.

### Signature

```typescript
function useShellSessions(): ShellSession[]
```

### Behaviour

- Subscribes to `SESSION_CREATED`, `SESSION_REMOVED`, and `SESSION_UPDATED` events on `shellManager`.
- Uses `useSyncExternalStore` for React 18 concurrent-mode safety.
- Caches the snapshot in a `useRef` and only creates a new array reference when the session list actually changes (by length or identity comparison). This prevents unnecessary re-renders in consumers.
- Returns `[]` for the server-side rendering snapshot.

### Usage

```tsx
const sessions = useShellSessions();

sessions.map((session) => (
  <Tab key={session.sessionId} label={session.name} />
));
```

### Related Hooks in the Same File

#### `useShell()`

Returns the full shell management interface including all sessions, session queries, session mutation methods, PTY methods, node management, and UI callbacks. Reads `computeNode` from `useAgentContext()` and passes it through to `shellManager` calls so the correct node is used for command execution.

Key return values:

| Property / Method | Type | Description |
|-------------------|------|-------------|
| `sessions` | `ShellSession[]` | Reactive list of all sessions. |
| `sessionCount` | `number` | Session count. |
| `getSession` | `(id) => ShellSession \| undefined` | Look up a session. |
| `createSession` | `(id, name, isPty?) => Promise<ShellSession \| null>` | Create a session. |
| `removeSession` | `(id) => boolean` | Remove a session. |
| `updateSessionName` | `(id, name) => boolean` | Rename a session. |
| `executeCommand` | `(command, sessionId) => Promise<FlowDataStream>` | Execute a command, using context `computeNode`. |
| `startPty` | `(sessionId, cols, rows) => Promise<void>` | Start a PTY. |
| `closePty` | `(sessionId) => Promise<void>` | Close a PTY. |
| `sendPtyInput` | `(sessionId, data) => Promise<void>` | Send raw input. |
| `resizePty` | `(sessionId, cols, rows) => Promise<void>` | Resize the terminal. |
| `setActiveNode` | `(node) => Promise<void>` | Set the active compute node. |
| `getActiveNode` | `() => ComputeNode \| null` | Get the active node. |
| `setOpenShellTab` | `(handler) => void` | Register a UI callback for opening the shell tab. |
| `openShellTab` | `(shellOffset?) => void` | Invoke the registered shell-tab-open callback. |

#### `useShellSession(sessionIdOrName)`

Returns reactive state for a single session. Uses `useSyncExternalStore` and subscribes to stream-level events (`render`, `substream-added`, `data`) in addition to `ShellManager` events. Returns `null` if the session does not exist.

Key return properties: `sessionId`, `name`, `stream`, `items` (all FlowData), `delta` (items added since last render), `createdAt`, `isRunning`, `commandCount`, `streamItemCount`, `isPty`, `ptyStarted`, `computeNodeId`, `terminalId`, `executeCommand`, `clearHistory`, `clearLog`.

---

## SessionViewer

**File:** `ui/src/components/live-workflow/SessionViewer.tsx`

`SessionViewer` is the live execution view rendered at `/dock/session/:processId`. It shows a tab bar of recent `AgenticProcess` sessions and a running conversation/FlowData stream for the currently active process.

### Layout

```
SessionTabBar          ← tab bar (session tabs + "+" button)
RunningArea            ← FlowData conversation stream + status footer
InterferenceBox        ← compact prompt input
```

### Session Tabs

Session tabs are represented by the `SessionTab` interface:

```typescript
interface SessionTab {
  id: string;            // AgenticProcess entity ID
  name: string;          // Display name (see getSessionDisplayName below)
  favorite_index?: number | null;  // Persistent tab ordering key
}
```

On mount, the component queries the backend for up to 100 `AgenticProcess` entities ordered by `updated_at desc`, maps them to `SessionTab` objects, and stores them in local state. A module-level `sessionTabsCache` (`Map<string, SessionTab[]>`) keyed by project ID preserves tabs across navigation events within the same page session.

### Display Name Resolution

`getSessionDisplayName(process, fallback)` resolves tab names in priority order:

1. `process.context_data.display_name` (explicit user rename, stored in `context_data`).
2. First 30 characters of `process.instruction_content` (stripped of HTML comments).
3. The `fallback` string (e.g., `"Session 3"`).

### favorite_index

`favorite_index` is a numeric ordering key persisted on the `AgenticProcess` entity via `PUT /api/v1/graph/agentic_process/:id`. It controls the left-to-right order of tabs in the `SessionTabBar`.

**How it works:**

- Tabs without any `favorite_index` values are displayed in `updated_at desc` order (most recently modified first).
- Once any tab acquires a `favorite_index`, the entire tab list is sorted numerically by that field (ascending). Tabs with `null` sort to the end.
- A gap of 1000 is used between consecutive indexes (the `favoriteGap` constant), providing space for future insertions without renumbering.

**Setting `favorite_index`:**

| Action | Result |
|--------|--------|
| Creating a new session tab | Gets `favoriteMaxRef.current + 1000` (appended to end). |
| Drag-reordering a tab | Receives the midpoint of its new neighbors' indexes. If the midpoint would collide with the left neighbor, `left + 1` is used instead. If one neighbor is null, a sentinel value (`after - 1000` or `before + 1000`) is used. |
| Closing a tab | `favorite_index` is set to `null` via `persistFavoriteIndex(tabId, null)`. |

`persistFavoriteIndex(tabId, nextIndex)` sends a `PUT` request to update the field on the backend, so tab order survives page refreshes.

### Tab Lifecycle

| Action | Handler | Description |
|--------|---------|-------------|
| Select tab | `handleSelectTab(processId)` | Updates `activeTabId`, calls `navigation.openShell(processId, { resumeClaude: true })`. |
| Close tab | `handleCloseTab(tabId)` | Adds `tabId` to `closedSessionIdsRef`, sets its `favorite_index` to `null`, removes it from local state. If the closed tab was active, navigates to the first remaining tab or an empty shell. |
| Add new session | `handleAddSession()` | Creates a new `AgenticProcessor` and `AgenticProcess` via the compute node, assigns the next `favorite_index`, and navigates to the new process. |
| Rename session | `handleRenameSession(sessionId, newName)` | Updates `context_data.display_name` on the entity and calls `entity.save()`. Updates the local tab name. |
| Reorder tab (drag) | `handleReorderTab(sourceId, targetId)` | Splices the source tab to the target position and recalculates `favorite_index` using the fractional indexing approach described above. |

### Process Interaction

The component uses `useSessionProcess()` internally to get:
- `process` — the active `AgenticProcess` entity.
- `state` — `WorkerStatus` and execution state.
- `isRunning`, `completed`.
- `abortProcess()`, `appendInstruction(value)`, `injectInstruction(content)`.

The `RunningArea` sub-component receives `flowData`, `processState`, `elapsedTime`, `statusMessage`, `activityLabel`, and `tokenUsage` for display. The `InterferenceBox` receives `waitingForInput`, `inputId`, and the submit/inject callbacks.

### URL Synchronisation

`SessionViewer` reads `agenticProcessTypeId` from `useContext()` (set by the loader on initial navigation). On subsequent tab switches driven by dock state changes, a `useEffect` watches `currentDock.pointer` and calls `dataContext.setActiveEntityTypeId(new TypeId(...))` to sync the data context with the URL.

---

## NavigationActions

**File:** `ui/src/navigation/NavigationActions.ts`

`NavigationActions` wraps React Router's `navigate` function and provides typed shortcut methods. All navigation is URL-first: methods construct a `DockPointer`, serialise it to URL segments, and call `navigate`. The current URL's dock portion is stripped and replaced so the base path is preserved.

### Shell and Session Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `openShell` | `(sessionId?, options?): void` | Opens the `SHELL` view. `sessionId` is placed as the URL pointer. Options: `startClaude`, `resumeClaude`, `cwd`, `startCommand`, `skipPermissions` — passed as URL search parameters and read by the shell route loader. |
| `openShellProcess` | `(processId, options?): void` | Opens the `AGENTIC_PROCESS` view for a specific process terminal. `processId` can be `'new'` to trigger entity creation in the routing layer. Options: `t` (tab hint). |
| `openNewTerminal` | `(): void` | Shortcut for `openShell('new_terminal')`. |
| `openSession` | `(processId): void` | Opens the `SESSION` view (i.e., `SessionViewer`) for the given process. |
| `openAgenticProcess` | `(processId): void` | Opens the `AGENTIC_PROCESS` terminal view directly. |

### Core Navigation

| Method | Signature | Description |
|--------|-----------|-------------|
| `openDock` | `(pointer: DockPointer \| null): void` | Base method used by all shortcuts. Passing `null` strips the dock from the URL (closes the panel). |
| `closeDock` | `(): void` | Alias for `openDock(null)`. |
| `openTab` | `(tabType: ViewType, options?): void` | Opens any dock view by `ViewType`. Used for pinned tabs. |
| `switchToTab` | `(tabType: ViewType): void` | Idempotent — same as `openTab`. |

### Other Useful Methods

| Method | Description |
|--------|-------------|
| `openEditor(path?, options?)` | Opens the code editor, optionally at a specific line/column. |
| `openFile(path, options?)` | Chooses between docs viewer (`.md`) and editor based on extension. |
| `openExplorer(path?)` | Opens the file explorer at an optional path. |
| `openDocs(filePath?)` | Opens the docs/markdown viewer. |
| `openDiff(checkpointHash)` | Opens the diff/checkpoint viewer. |
| `openSettings(fieldName?, filter?)` | Opens the settings viewer, optionally scrolled to a field. |
| `openLens(category, type, ref, options?)` | Opens the lens viewer (transcripts, tasks, etc.). |
| `openTasks(taskId?)` | Opens the tasks view. |
| `goBack()` / `goForward()` | Browser history navigation. |
| `getShareableUrl()` / `copyShareableUrl()` | Returns or copies the current URL to the clipboard. |

### Usage Example

```typescript
const { navigation } = useDockNavigation();

// Open a resumed Claude session in the shell view
navigation.openShell('abc-123', { resumeClaude: true });

// Open the SessionViewer for an AgenticProcess
navigation.openSession('proc-456');

// Open the process terminal view
navigation.openAgenticProcess('proc-456');

// Open a new terminal tab
navigation.openNewTerminal();
```
