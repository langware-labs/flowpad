# Terminal Toolbars

Reference for `ProcessToolbar`, `RestartRequiredOverlay`, and the state model that drives them.

---

## Table of Contents

1. [Component Hierarchy](#1-component-hierarchy)
2. [ProcessToolbar](#2-processtoolbar)
3. [Controls Reference](#3-controls-reference)
   - [Chrome Toggle](#31-chrome-toggle)
   - [Full Trust Toggle](#32-full-trust-toggle)
   - [Show Events Toggle](#33-show-events-toggle)
   - [Open Terminal Button](#34-open-terminal-button)
   - [Fork Button](#35-fork-button)
   - [Restart Button](#36-restart-button)
   - [Session Info Popover](#37-session-info-popover)
4. [RestartRequiredOverlay](#4-restartrequiredoverlay)
5. [State Management](#5-state-management)
6. [Key Files Reference](#6-key-files-reference)

---

## 1. Component Hierarchy

`ProcessToolbar` and `RestartRequiredOverlay` are rendered inside `InteractiveTerminal`, which is itself nested under `ProcessTerminal` inside `TabbedTerminal`.

```
TabbedTerminal.tsx
  └── ProcessTerminal.tsx          (ViewType.AGENTIC_PROCESS)
        └── InteractiveTerminal.tsx
              ├── ProcessToolbar.tsx          (toolbar strip at top)
              │     └── RestartRequiredOverlay.tsx  (conditional overlay)
              ├── SnifferGutter.tsx
              └── AnnotationGutter.tsx
```

`InteractiveTerminal` mounts `ProcessToolbar` only when a `process` prop (`AgenticProcess`) is passed:

```tsx
// InteractiveTerminal.tsx line 678
{process && <ProcessToolbar process={process} showEvents={showEvents} onToggleShowEvents={setShowEvents} />}
```

`RestartRequiredOverlay` is rendered by `ProcessToolbar` itself (not by `InteractiveTerminal`) when pending flag changes exist. It renders as an `absolute inset-0` element that visually overlays the terminal content area.

---

## 2. ProcessToolbar

**File**: `ui/src/components/terminal/interactive-terminal/ProcessToolbar.tsx`

A narrow icon-only strip rendered above the xterm.js viewport. It exposes controls for the two flags baked into the PTY command (`chrome`, `permission_mode`), session lifecycle actions (Fork, Restart), a convenience shortcut to open a plain shell in the process working directory, an event visibility toggle, and a session information popover.

### Props

| Prop | Type | Description |
|------|------|-------------|
| `process` | `AgenticProcess` | The active process entity. All flag reads and session operations are performed against this object. |
| `showEvents` | `boolean` | Current visibility state of the `SnifferGutter` event annotations. Controlled by the parent (`InteractiveTerminal`). |
| `onToggleShowEvents` | `(v: boolean) => void` | Callback to toggle `showEvents` in the parent. |

### Layout

The toolbar is a horizontal flex container (`flex items-center gap-0.5 border-b bg-muted/30 px-2 py-1`). Controls are laid out left to right:

```
[Chrome] [Trust] [Events]   <spacer>   [Terminal] [Fork] [Restart] [Info?]
```

The `[Info]` button only renders when `process.worker_session_id` is set (`hasSession === true`).

All buttons are wrapped in `TooltipProvider` with a 300 ms delay. Each button is an `IconToggleButton` sub-component that renders a `lucide-react` icon inside a `7×7` button. Active state is indicated by a highlight class (`activeClassName`); disabled state applies `opacity-40` and `cursor-not-allowed`.

---

## 3. Controls Reference

### 3.1 Chrome Toggle

| Property | Value |
|----------|-------|
| Icon | `Chrome` (lucide-react) |
| Active color | `text-amber-500 dark:text-amber-400` |
| Source field | `process.context_data.chrome` (boolean) |
| Pending state | `pendingChrome` (local `useState`) |
| Disabled when | `!hasSession` (no `worker_session_id`) |

**What "Chrome mode" means**: When enabled, the `--chrome` flag is appended to the Claude CLI invocation. This tells Claude Code to spawn and control a Chromium browser instance, enabling browser automation tools in the agent's toolset. Without `--chrome`, browser control tools are unavailable.

**How the toggle works**:

1. The current value is read from `process.context_data?.chrome`.
2. A local `pendingChrome` state mirrors the current value on mount and whenever the entity updates (via `useEffect` on `currentChrome`).
3. Clicking the button calls `setPendingChrome(v => !v)`. This does not immediately persist or restart anything.
4. If `pendingChrome !== currentChrome`, `hasPendingChanges` becomes `true` and `RestartRequiredOverlay` is displayed.
5. When the user confirms in the overlay, `handleApply` writes the new value into `context_data` on the entity, saves it, and calls `claudeSessionManager.restartSession(process)`.
6. If the user cancels, `handleCancelChanges` resets `pendingChrome` back to `currentChrome`.

The toggle is disabled before the first session is launched because `context_data` is baked into the PTY command; there is no running PTY to restart.

---

### 3.2 Full Trust Toggle

| Property | Value |
|----------|-------|
| Icon | `ShieldOff` (lucide-react) |
| Active color | `text-amber-500 dark:text-amber-400` |
| Source field | `process.context_data.permission_mode === 'bypassPermissions'` |
| Pending state | `pendingDanger` (local `useState`) |
| Disabled when | `!hasSession` |

**What trust mode means**: Controls the `--dangerously-skip-permissions` flag passed to Claude CLI. When enabled (`bypassPermissions`), Claude Code skips all permission prompts and executes file writes, shell commands, and other potentially destructive operations without asking the user. When disabled (`askUser`), Claude pauses and prompts before any sensitive tool call.

**How the toggle works**: The flow is identical to the Chrome toggle — changes are staged in `pendingDanger`, displayed as pending, and applied atomically by `handleApply` together with any Chrome changes. Both flags are written to `context_data` in a single `process.save()` call before the restart.

The serialization mapping in the backend:

```
pendingDanger === true  → context_data.permission_mode = 'bypassPermissions'
                          → CLI flag: --dangerously-skip-permissions
pendingDanger === false → context_data.permission_mode = 'askUser'
                          → (no flag added)
```

---

### 3.3 Show Events Toggle

| Property | Value |
|----------|-------|
| Icon | `Activity` (lucide-react) |
| Active color | `text-primary` |
| Source | `showEvents` prop (controlled by `InteractiveTerminal`) |
| Always enabled | Yes — no `hasSession` requirement |

Controls the visibility of `SnifferGutter`, the left-side gutter inside `InteractiveTerminal` that renders inline event annotations aligned to terminal output lines. When toggled off, `showGutter` in `InteractiveTerminal` becomes `false` and the `SnifferGutter` component is not mounted. The annotation gutter (`AnnotationGutter`) on the right side is unaffected by this toggle; it is controlled by `showAnnotationGutter` which depends only on `process.worker_session_id`.

Clicking calls `onToggleShowEvents(!showEvents)` which sets `showEvents` in `InteractiveTerminal`'s local state.

---

### 3.4 Open Terminal Button

| Property | Value |
|----------|-------|
| Icon | `SquareTerminal` (lucide-react) |
| Always enabled | Yes |
| Behavior | Opens a new plain shell tab in the process working directory |

Clicking calls `navigation.openShell(undefined, { cwd: workdir || undefined })` where `workdir` is read from `process.context_data?.workdir`. If `workdir` is empty, a shell opens in the default directory. This button is a convenience shortcut for inspecting or manually modifying the filesystem context of the running agent without interrupting the agent session itself.

The `navigation` object comes from the `useDockNavigation()` hook.

---

### 3.5 Fork Button

| Property | Value |
|----------|-------|
| Icon | `GitFork` (lucide-react) |
| Disabled when | `!hasSession` or `isForking` |
| Tooltip (enabled) | `"Fork session — new tab, same settings"` |
| Tooltip (disabled) | `"Launch a session first"` |

**What fork does**: Creates a sibling `AgenticProcess` entity that shares all settings (`context_data`) from the current process but starts with a completely empty session history (no JSONL transcript is copied). The fork gets its own `worker_session_id` and a new PTY.

**Handler** (`handleFork`):

```ts
const handleFork = async () => {
  if (isForking) return;
  setIsForking(true);
  try {
    const newProcess = await claudeSessionManager.forkSession(process);
    navigation.openShellProcess(newProcess.id);
  } finally {
    setIsForking(false);
  }
};
```

`claudeSessionManager.forkSession(process)` performs:
1. Reads `context_data` from the source process to build an `AgenticContext`.
2. Calls `AgenticProcessor.getById(process.processor_id)` to locate the parent processor.
3. `processor.createProcess(context)` creates a new entity row.
4. `newProcess.startPty()` spawns a fresh PTY with a new `worker_session_id`.
5. Emits `SESSION_FORKED`.

After the fork returns, `navigation.openShellProcess(newProcess.id)` opens the new process in a new dock tab and navigates to it.

The `isForking` guard prevents double-clicks from triggering concurrent fork operations.

---

### 3.6 Restart Button

| Property | Value |
|----------|-------|
| Icon | `RotateCcw` (lucide-react) |
| Disabled when | `!hasSession` or `isRestarting` |
| Tooltip (enabled) | `"Restart session"` |
| Tooltip (disabled) | `"Launch a session first"` |

**What restart does**: Kills the running PTY and resumes it on the same `worker_session_id`, so Claude Code picks up the conversation from where it left off (`--resume <worker_session_id>`). The session history (JSONL transcript) is preserved; only the OS-level PTY process is recycled.

There is no confirmation dialog for the standalone Restart button. The action is immediate.

**Handler** (`handleRestart`):

```ts
const handleRestart = async () => {
  if (isRestarting) return;
  setIsRestarting(true);
  try {
    await claudeSessionManager.restartSession(process);
  } finally {
    setIsRestarting(false);
  }
};
```

`claudeSessionManager.restartSession(process)` internally calls `killPty()` then `resumePty()` and emits `SESSION_RESTARTED`.

Note: When flag changes are pending (`hasPendingChanges === true`), confirming the `RestartRequiredOverlay` also calls `restartSession` via `handleApply`. The standalone Restart button does not flush pending flag changes — it restarts with the currently persisted `context_data`.

---

### 3.7 Session Info Popover

| Property | Value |
|----------|-------|
| Icon | `Info` (lucide-react) |
| Rendered | Only when `hasSession` (`!!process.worker_session_id`) |
| Trigger | Click |
| Position | `side="bottom"`, `align="end"` |

Opens a `Popover` component showing a table of current session details. The data is read directly from the process entity at render time — it is not re-fetched on open.

**Displayed fields**:

| Label | Source |
|-------|--------|
| Status | `process.state?.status` |
| Working Dir | `context_data.workdir` (falls back to `"(not set)"`) |
| Session ID | `process.worker_session_id` |
| PTY ID | `process.pty_pid` (falls back to `"none (detached)"`) |
| Permission | `context_data.permission_mode` (falls back to `"bypassPermissions"`) |
| Chrome | `context_data.chrome` — displayed as `"enabled"` or `"disabled"` |
| Model | `context_data.model` (falls back to `"(default)"`) |
| Command | Reconstructed CLI string (see below) |

**Command reconstruction** (in `SessionInfoPopover`):

```ts
const parts = ['claude'];
if (permMode === 'bypassPermissions') parts.push('--dangerously-skip-permissions');
if (chrome) parts.push('--chrome');
parts.push('--session-id', process.worker_session_id || '?');
if (model && model !== '(default)') parts.push('--model', model);
const command = parts.join(' ');
```

This gives a human-readable approximation of the command the backend used to launch the PTY. The full command on the backend also includes environment variables (`CLAUDE_PROJECT_DIR`, `AGENT_HOOKS_REPORT_URL`, `FLOWPAD_EXECUTION_SCOPE`) and the `-p` prompt flag, which are not shown here.

---

## 4. RestartRequiredOverlay

**File**: `ui/src/components/terminal/interactive-terminal/RestartRequiredOverlay.tsx`

A modal-style overlay that blocks interaction with the terminal area when pending flag changes require a PTY restart to take effect.

### Props

| Prop | Type | Description |
|------|------|-------------|
| `onRestart` | `() => void` | Called when the user clicks the Restart button. Bound to `handleApply` in `ProcessToolbar`. |
| `onCancel` | `() => void` | Called when the user clicks the Cancel button. Bound to `handleCancelChanges` in `ProcessToolbar`. |
| `isRestarting` | `boolean` | When `true`, both buttons are disabled and the Restart button shows a spinner with "Restarting..." text. Bound to `isApplying` state in `ProcessToolbar`. |

### When it appears

`ProcessToolbar` renders `RestartRequiredOverlay` when both of the following are true:

```ts
const hasPendingChanges = pendingChrome !== currentChrome || pendingDanger !== currentDanger;
// and
const canToggle = hasSession; // worker_session_id is set
```

```tsx
{hasPendingChanges && canToggle && (
  <RestartRequiredOverlay
    onRestart={() => void handleApply()}
    onCancel={handleCancelChanges}
    isRestarting={isApplying}
  />
)}
```

The overlay will never appear before the first session is started (because `canToggle` requires `hasSession`), and it disappears as soon as `pendingChrome === currentChrome && pendingDanger === currentDanger` — either because the restart completed (the entity updated and the `useEffect` reset pending state) or because the user cancelled.

### Visual behavior

The overlay renders as `absolute inset-0 z-10` with a semi-transparent blurred backdrop (`bg-background/80 backdrop-blur-sm`). It covers the entire terminal content area. A centered card contains:

- A `RotateCw` icon (spinning when `isRestarting`)
- Heading: "Restart Required"
- Subtext: "Flag changes require a terminal restart to take effect."
- Two buttons: **Cancel** (outline) and **Restart** (primary)

### What "Restart" does in the overlay

`onRestart` is bound to `handleApply`:

```ts
const handleApply = async () => {
  setIsApplying(true);
  try {
    const updatedContext = { ...(process.context_data ?? {}) };
    updatedContext.chrome = pendingChrome;
    updatedContext.permission_mode = pendingDanger ? 'bypassPermissions' : 'askUser';
    process.context_data = updatedContext;
    await process.save();                              // Persist new context_data to DB
    await claudeSessionManager.restartSession(process); // killPty → resumePty
  } finally {
    setIsApplying(false);
  }
};
```

The `process.save()` call is critical — it persists the new `context_data` before `resumePty()` is called. `resumePty()` on the backend reads `context_data` to reconstruct the CLI command, so saving must happen first.

After `restartSession` resolves, the backend entity is updated (new `pty_pid`, same `worker_session_id`). When the entity propagates back to the frontend, `currentChrome` and `currentDanger` are recalculated, the `useEffect` fires `setPendingChrome(currentChrome)` and `setPendingDanger(currentDanger)`, `hasPendingChanges` becomes `false`, and the overlay unmounts.

### What "Cancel" does in the overlay

`onCancel` is bound to `handleCancelChanges`:

```ts
const handleCancelChanges = () => {
  setPendingChrome(currentChrome);
  setPendingDanger(currentDanger);
};
```

This resets both pending values to the currently persisted values. No network calls are made. `hasPendingChanges` becomes `false` and the overlay unmounts immediately.

---

## 5. State Management

### State variables in ProcessToolbar

| Variable | Type | Initial value | Purpose |
|----------|------|--------------|---------|
| `pendingChrome` | `boolean` | `currentChrome` | Staged value for the Chrome flag before confirmation |
| `pendingDanger` | `boolean` | `currentDanger` | Staged value for the trust flag before confirmation |
| `isApplying` | `boolean` | `false` | `true` while `handleApply` is running; disables overlay buttons and shows spinner |
| `isForking` | `boolean` | `false` | `true` while `handleFork` is running; prevents duplicate fork actions |
| `isRestarting` | `boolean` | `false` | `true` while `handleRestart` is running; disables restart button |

### Derived values

```ts
const hasSession = !!process.worker_session_id;
const canToggle = hasSession;
const workdir = (process.context_data?.workdir as string) || '';

const currentChrome = (process.context_data?.chrome as boolean) ?? false;
const currentDanger = (process.context_data?.permission_mode as string) === 'bypassPermissions';

const hasPendingChanges = pendingChrome !== currentChrome || pendingDanger !== currentDanger;
```

### Entity sync via useEffect

`pendingChrome` and `pendingDanger` are reset whenever the entity changes:

```ts
useEffect(() => {
  setPendingChrome(currentChrome);
  setPendingDanger(currentDanger);
}, [currentChrome, currentDanger]);
```

This ensures that if an external change to `context_data` occurs (e.g., a background update from the backend), the pending state resets to match the authoritative entity state, and any pending overlay is dismissed.

### showEvents state in InteractiveTerminal

The `showEvents` boolean is owned by `InteractiveTerminal` as `useState(true)` (default on). `ProcessToolbar` reads it as a prop and mutates it through the `onToggleShowEvents` callback:

```ts
// InteractiveTerminal.tsx
const [showEvents, setShowEvents] = useState(true);
// ...
<ProcessToolbar process={process} showEvents={showEvents} onToggleShowEvents={setShowEvents} />
```

`showEvents` controls `showGutter`:

```ts
const showGutter = !!process && showEvents;
```

When `showGutter` is `false`, `SnifferGutter` is not rendered.

### What drives toolbar availability

The central guard for all session-dependent controls is `hasSession`:

```ts
const hasSession = !!process.worker_session_id;
```

`worker_session_id` is `null` until `startPty()` is called for the first time. After the first start it persists in the database across PTY restarts, tab switches, and page refreshes. Controls gated on `hasSession`:

- Chrome toggle (disabled before session start)
- Full Trust toggle (disabled before session start)
- Fork button (`disabled={!hasSession || isForking}`)
- Restart button (`disabled={!hasSession || isRestarting}`)
- Session Info popover (not rendered at all)

The Show Events toggle and Open Terminal button are always enabled regardless of session state.

---

## 6. Key Files Reference

| File | Role |
|------|------|
| `ui/src/components/terminal/interactive-terminal/ProcessToolbar.tsx` | Toolbar component, all controls, `RestartRequiredOverlay` mounting |
| `ui/src/components/terminal/interactive-terminal/RestartRequiredOverlay.tsx` | Overlay UI for pending flag changes |
| `ui/src/components/terminal/interactive-terminal/InteractiveTerminal.tsx` | Mounts `ProcessToolbar`, owns `showEvents` state |
| `ts_sdk/src/services/claude/claudeSessionManager.ts` | `forkSession()`, `restartSession()`, `killSession()` |
| `ts_sdk/src/agentic_processor/agentic-process.ts` | `AgenticProcess` entity class — `worker_session_id`, `pty_pid`, `context_data`, `state` |
| `ts_sdk/src/agentic_processor/agentic-context.ts` | `AgenticContext` DTO — `chrome`, `permissionMode`, `workdir`, `model` |
| `ui/src/navigation/NavigationActions.ts` | `openShell()`, `openShellProcess()` — used by Fork and Open Terminal |
