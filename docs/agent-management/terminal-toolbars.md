# Terminal Toolbars

Reference for the current terminal toolbar and session controls in the frontend.

This document describes the interactive PTY terminal UI. The same
`AgenticProcess` entity can also run in CLI/headless mode, but headless mode
does not render `InteractiveTerminal`, `ProcessToolbar`, xterm.js, gutters, or
the restart overlay. See [PTY Mode vs CLI/Headless Mode](#6-pty-mode-vs-cliheadless-mode).

---

## Table of Contents

1. [Component Hierarchy](#1-component-hierarchy)
2. [ProcessToolbar](#2-processtoolbar)
3. [Controls Reference](#3-controls-reference)
   - [CLI Options Dropdown](#31-cli-options-dropdown)
   - [Columns & Trace Dropdown](#32-columns--trace-dropdown)
   - [Session Actions](#33-session-actions)
   - [API Timeout Toast](#34-api-timeout-toast)
4. [RestartRequiredOverlay](#4-restartrequiredoverlay)
5. [InteractiveTerminal State](#5-interactiveterminal-state)
6. [PTY Mode vs CLI/Headless Mode](#6-pty-mode-vs-cliheadless-mode)
7. [Key Files Reference](#7-key-files-reference)

---

## 1. Component Hierarchy

`ProcessToolbar` is rendered by `InteractiveTerminal` only for the Claude PTY
pane. When the sidecar shell pane is active, the top bar switches to `PaneBar`
instead.

```text
InteractiveTerminal.tsx
  |-- ProcessToolbar.tsx                 (Claude pane top bar)
  |     |-- RestartRequiredOverlay.tsx   (pending CLI option changes)
  |     |-- WorktreeButtons.tsx          (worktree-specific actions)
  |     `-- PTYViewer                    (opened from Columns & Trace)
  |-- PaneBar.tsx                        (sidecar shell pane top bar)
  |-- ColumnHeaderBar.tsx                (trace/time/annotation column headers)
  |-- TraceGutter.tsx
  |-- TimeGutter.tsx
  |-- AnnotationGutter.tsx
  |-- SideWindow                         (Git, Prompts, Queue, Files panels)
  |-- SidecarShellTerminal.tsx
  `-- TerminalBottomRibbon.tsx           (status, queue, side-tab toggles)
```

The current render guard is:

```tsx
{process && activePane === 'claude' && (
  <ProcessToolbar
    process={process}
    traceFilters={traceFilters}
    onTraceFiltersChange={setTraceFilters}
    colVis={colVis}
    onColVisChange={setColVis}
    sessionStartTime={sessionStartTime}
    lastMessageTime={lastMessageTime}
    embedded={embedded}
    onClose={onClose}
    shell={shell}
  />
)}
{activePane === 'shell' && sidecarShellId && <PaneBar label="Shell" onClose={() => void handleKillSidecar()} />}
```

`InteractiveTerminal` resolves the process from `process` props first, then the
current context process. It notifies parents with `process.session_id`, not the
older `worker_session_id` name.

---

## 2. ProcessToolbar

**File**: `ui/src/components/terminal/interactive-terminal/ProcessToolbar.tsx`

`ProcessToolbar` is a compact top strip for an interactive `AgenticProcess`
running in a PTY-backed shell. It groups CLI launch flags into one dropdown,
groups trace/column display controls into another dropdown, and exposes session
actions such as restart, fork, transcript, worktree, and plain-terminal launch.

### Props

| Prop | Type | Description |
|------|------|-------------|
| `process` | `AgenticProcess` | Active process entity. Toolbar actions call methods on this object directly. |
| `traceFilters` | `TraceFilters` | UI filters for trace events, time fields, and prompt annotations. |
| `onTraceFiltersChange` | `(f: TraceFilters) => void` | Persists trace filter changes in `InteractiveTerminal`. |
| `colVis` | `ColVisibility` | Visibility state for trace, time, and annotation columns. |
| `onColVisChange` | `(v: ColVisibility) => void` | Persists column visibility changes in `InteractiveTerminal`. |
| `sessionStartTime` | `string \| null \| undefined` | Session start timestamp shown in the session info popover. |
| `lastMessageTime` | `string \| null \| undefined` | Latest transcript message timestamp shown in the session info popover. |
| `embedded` | `boolean \| undefined` | Hides nav-out actions and shows a close button when true. |
| `onClose` | `(() => void) \| undefined` | Close handler used only in embedded mode. |
| `shell` | `Shell \| null \| undefined` | Linked shell entity used for prompt injection and PTY viewer. |

### Core Derived State

```ts
const hasSession = !!process.session_id;
const workerStatus = process.workerStatus;

// Gates Restart, CLI option changes, and Apply.
const started = process.status === ProcessStatus.RUNNING;

// Gates Fork and Open Transcript.
const hasTranscript =
  hasSession &&
  hasWorkerStarted(workerStatus) &&
  workerStatus !== WorkerStatus.IDLE;

const canFork = hasTranscript;
const canToggle = started;
const workdir = process.workdir ?? '';

const currentChrome = process.cliOptions.chrome;
const currentDanger = process.cliOptions.permission_mode === 'bypassPermissions';
const currentDebug = process.cliOptions.debug;
```

The current source of truth for launch flags is `process.cliOptions`, backed by
`cli_config`. The older doc model that read Chrome, permission mode, workdir, and
model from `context_data` is no longer accurate for the toolbar.

### Layout

Controls are laid out left to right:

```text
[CLI Options] [Columns & Trace] <spacer>
[Commit & Merge?] [Open Terminal?] [Fork?] [Open in Worktree?]
[Restart] [Session Info?] [Open Transcript?] [Close?]
```

`Commit & Merge`, `Open Terminal`, `Fork`, and `Open in Worktree` are hidden when
`embedded` is true. The `Close` button is shown only when `embedded` is true and
`onClose` is provided. `Session Info` and `Open Transcript` render only after
`process.session_id` is set.

Session action icon buttons use a 300 ms tooltip delay. Disabled action buttons
stay wrapped in a span so their tooltips still fire. The two dropdown trigger
buttons use `title`, and the session info control opens a popover.

---

## 3. Controls Reference

### 3.1 CLI Options Dropdown

| Property | Value |
|----------|-------|
| Icon | `SlidersHorizontal` |
| Active color | `text-amber-500 dark:text-amber-400` |
| Active when | Any staged CLI option value is enabled: Chrome, Full Trust, or Debug |
| Disabled items when | `process.status !== ProcessStatus.RUNNING` |
| Applies to | PTY mode only |

The dropdown contains three `RichCheckboxItem` controls:

| Label | Source | Pending state | CLI effect |
|-------|--------|---------------|------------|
| Chrome browser | `process.cliOptions.chrome` | `pendingChrome` | Adds `--chrome` |
| Full Trust | `process.cliOptions.permission_mode === 'bypassPermissions'` | `pendingDanger` | Adds `--dangerously-skip-permissions` when true; stores `askUser` when false |
| Debug logging | `process.cliOptions.debug` | `pendingDebug` | Adds `--debug` |

Changing a checkbox only stages local pending state. It does not immediately save
or restart the process.

```ts
const hasPendingChanges =
  pendingChrome !== currentChrome ||
  pendingDanger !== currentDanger ||
  pendingDebug !== currentDebug;
```

When pending values differ from the persisted `cli_config` values,
`RestartRequiredOverlay` is rendered. Applying the overlay writes all staged CLI
options to `process.cliOptions`, saves the process, then restarts the PTY:

```ts
const updatedCli = process.cliOptions;
updatedCli.chrome = pendingChrome;
updatedCli.permission_mode = pendingDanger ? 'bypassPermissions' : 'askUser';
updatedCli.debug = pendingDebug;
process.cliOptions = updatedCli;
await process.save();
await process.restart();
```

`AgenticProcess.cliOptions` is a getter/setter around `cli_config`. The getter
also injects `session_id`, `workdir`, `CLAUDE_PROJECT_DIR`, and
`additional_dirs`, so the toolbar should use `process.cliOptions` rather than
reading those launch flags from `context_data`.

**PTY mode**: the dropdown is available only in the interactive terminal, and
items are enabled only while the process lifecycle status is `RUNNING`. Changing
these flags requires restarting the PTY so Claude Code is relaunched with the new
CLI args.

**CLI/headless mode**: this dropdown is not rendered. Headless callers set these
options when creating the process (`AgenticProcess.spawn` / `AgenticContext`) or
by updating `cliOptions` programmatically before a future run. There is no
toolbar overlay because there is no live xterm/Shell PTY to restart from the UI.

### 3.2 Columns & Trace Dropdown

| Property | Value |
|----------|-------|
| Icon | `BugPlay` |
| Active color | `text-primary` |
| Active when | Any column is hidden or any time-gutter field is enabled |
| State owner | `InteractiveTerminal` |
| Applies to | PTY mode only |

This dropdown changes local terminal display state. It does not save the
`AgenticProcess`, does not touch `cli_config`, and does not require restart.

Column controls:

| Item | State | Behavior |
|------|-------|----------|
| Trace events | `colVis.trace && traceFilters.events` | Enabling sets `colVis.trace = true` and `traceFilters.events = true`; disabling sets `colVis.trace = false`. |
| Time gutter | `colVis.time` | Shows or hides the time/index gutter column. |
| Annotations | `colVis.annotations` | Shows or hides the right annotation gutter. |
| Prompt annotations | `traceFilters.promptAnnotations` | Includes or filters prompt anchor annotations in the annotation gutter. |

Time gutter field controls:

| Item | State key | Meaning |
|------|-----------|---------|
| Time | `traceFilters.time` | PTY chunk receipt time |
| Index (seq) | `traceFilters.index` | PTY owner sequence number |
| Line | `traceFilters.line` | Logical line number |
| Abs line | `traceFilters.absLine` | Absolute row index |
| Row time range | `traceFilters.debugTime` | PTY segment duration |
| Anchor time range | `traceFilters.refTime` | Anchor start/stop range |

The dropdown also contains a `PTY Viewer` item that opens `PTYViewer` with the
linked `shell` entity. This is meaningful only for PTY-backed sessions.

`InteractiveTerminal` persists these UI preferences to local storage keys:

```ts
const LS_KEY = 'traceFilters';
const COL_VIS_LS_KEY = 'colVisibility';
```

### 3.3 Session Actions

#### Commit & Merge

**File**: `ui/src/components/terminal/interactive-terminal/WorktreeButtons.tsx`

Rendered only when all of the following are true:

- `embedded` is false.
- `process.cliOptions.worktree` is true.

Clicking injects a fixed commit-and-merge prompt into the live PTY via:

```ts
shell?.sendInput(text + '\r')
```

The button then watches `process.workerStatus`. Once the worker has been busy
and transitions back out of a running worker state, it calls
`navigation.openShellView()`.

This is a PTY-only workflow because it injects text into the linked `Shell`.

#### Open Terminal

Rendered only when `embedded` is false.

Clicking opens a new plain shell tab in the process working directory:

```ts
navigation.openNewShell({ cwd: workdir || undefined })
```

This creates a separate shell for manual inspection. It does not interrupt,
restart, or mutate the agent process.

#### Fork

Rendered only when `embedded` is false.

| Property | Current behavior |
|----------|------------------|
| Icon | `GitFork` |
| Disabled when | `!hasTranscript || isForking` |
| Enabled tooltip | `Fork session - new tab, same conversation history` |
| Handler | `process.fork(true)`, then `navigation.openShellProcess(newProcess.id)` |

`hasTranscript` means:

```ts
!!process.session_id &&
hasWorkerStarted(process.workerStatus) &&
process.workerStatus !== WorkerStatus.IDLE
```

Forking now preserves the conversation history and diverges into a new session,
equivalent to resuming the current Claude session with `--fork-session`. It is
not an empty-history clone.

`AgenticProcess.fork(true)` calls the backend `fork` action, registers the new
process entity, then calls `newProcess.start()` so the fork opens with a live
PTY. The toolbar then opens that process in a shell-process tab.

#### Open in Worktree

**File**: `ui/src/components/terminal/interactive-terminal/WorktreeButtons.tsx`

Rendered only when `embedded` is false.

The button checks whether the current `workdir` is a git repository with at
least one commit. It is disabled while that check is loading or when no commit
exists. When clicked, it starts a new visible process in an isolated worktree:

```ts
const { process: newProcess } = await AgenticProcess.spawn(
  {
    worktree: true,
    workdir,
    permissionMode: process.cliOptions.permission_mode,
  },
  { visible: true },
);
navigation.openDock(newProcess.dockPointer);
```

This is a PTY flow: `AgenticProcess.spawn` without `headless: true` calls
`process.start()` and links a `Shell`.

#### Restart

| Property | Current behavior |
|----------|------------------|
| Icon | `RotateCcw` |
| Disabled when | `process.status !== ProcessStatus.RUNNING` or `isRestarting` |
| Handler | `process.restart()` |

The standalone Restart button is immediate and has no confirmation dialog.

`AgenticProcess.restart()` stops the current shell session, starts it again, and
emits `restarted`:

```ts
if (this.shell_id) await this.stop();
await this.start();
this.emit('restarted', { process: this });
```

`InteractiveTerminal` listens for `restarted`, resets its PTY sync session, and
re-attaches the shell with `force: true`:

```ts
shell?.attachPty({ cols: term?.cols ?? 80, rows: term?.rows ?? 24, force: true })
```

The session history is preserved through `process.session_id`. Pending CLI
option changes are saved only by the restart overlay's Apply action, not by the
standalone Restart button.

#### Session Info

Rendered only when `process.session_id` is set.

The popover reads current values directly from the process entity and
`process.cliOptions`. Rows are copyable.

| Label | Source |
|-------|--------|
| Process ID | `process.id` |
| Status | `process.status` |
| CLI worker status | `process.workerStatus` |
| Started | `sessionStartTime`, formatted by `useTimeDisplay` |
| Last message | `lastMessageTime`, formatted by `useTimeDisplay` |
| Working Dir | `process.workdir` |
| Session ID | `process.session_id` |
| PTY ID | `process.pty_pid` |
| Permission | `process.cliOptions.permission_mode` |
| Chrome | `process.cliOptions.chrome` |
| Debug | `process.cliOptions.debug` |
| Worktree | `process.cliOptions.worktree` |
| Model | `process.cliOptions.model` |
| Command | Approximate display command reconstructed in the popover |

The display command includes `claude`, the enabled CLI flags, `--session-id`,
and optional `--model`. It is a human-readable summary, not necessarily the
complete backend command environment.

#### Open Transcript

Rendered only when `process.session_id` is set.

| Property | Current behavior |
|----------|------------------|
| Icon | `ScrollText` |
| Disabled when | `!hasTranscript` |
| Handler | Discover `ClaudeSessionRecord`, then open the transcript lens |

Clicking resolves the encoded project name from
`ClaudeSessionRecord.discover(sessionId)` when possible, falling back to
`workdir.replace(/\//g, '-')`, then calls:

```ts
navigation.openLens('claude', 'transcript', `${projectEncodedName}/${sessionId}`);
```

#### Close

Rendered only in embedded mode when `onClose` is provided. It calls `onClose`
directly and does not close the process by itself.

### 3.4 API Timeout Toast

`ProcessToolbar` watches `process.workerStatus`. When it becomes
`WorkerStatus.API_TIMEOUT`, the toolbar shows an infinite toast:

- Title: `Agent is taking a long time to respond`
- Description: `The Anthropic API may be slow or unresponsive.`
- `Terminate`: calls `process.close()` and dismisses the toast.
- `Keep Waiting`: only dismisses the toast.

If the worker status recovers before the user acts, the toast is dismissed
automatically.

---

## 4. RestartRequiredOverlay

**File**: `ui/src/components/terminal/interactive-terminal/RestartRequiredOverlay.tsx`

The overlay appears when all staged CLI option values match this condition:

```ts
const hasPendingChanges =
  pendingChrome !== currentChrome ||
  pendingDanger !== currentDanger ||
  pendingDebug !== currentDebug;

{hasPendingChanges && canToggle && (
  <RestartRequiredOverlay
    onRestart={() => void handleApply()}
    onCancel={handleCancelChanges}
    isRestarting={isApplying}
  />
)}
```

`canToggle` is `process.status === ProcessStatus.RUNNING`, so the overlay is a
PTY-session control for a currently running interactive process.

### Props

| Prop | Type | Description |
|------|------|-------------|
| `onRestart` | `() => void` | Bound to `handleApply`; saves pending `cli_config` and restarts. |
| `onCancel` | `() => void` | Resets pending values to the persisted CLI options. |
| `isRestarting` | `boolean` | Disables both buttons and shows a spinner while Apply is in flight. |

### Visual Behavior

The overlay renders as:

```tsx
<div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 backdrop-blur-sm">
```

Because `InteractiveTerminal` is a relative container, this blocks terminal
interaction while pending launch-flag changes are unresolved. The centered card
shows:

- `RotateCw` icon, spinning while applying.
- Heading: `Restart Required`.
- Subtext: `Flag changes require a terminal restart to take effect.`
- `Cancel` and `Restart` buttons.

### Apply vs Cancel

Apply saves all three staged options (`chrome`, `permission_mode`, `debug`) to
`process.cliOptions`, persists the process, then calls `process.restart()`.

Cancel resets all three pending values:

```ts
setPendingChrome(currentChrome);
setPendingDanger(currentDanger);
setPendingDebug(currentDebug);
```

Cancel makes no network calls.

---

## 5. InteractiveTerminal State

**File**: `ui/src/components/terminal/interactive-terminal/InteractiveTerminal.tsx`

### Trace and Column State

`InteractiveTerminal` owns trace and column preferences and passes them into
`ProcessToolbar`.

```ts
const DEFAULT_FILTERS: TraceFilters = {
  events: true,
  time: false,
  index: false,
  line: false,
  absLine: false,
  debugTime: false,
  refTime: false,
  promptAnnotations: false,
};

const DEFAULT_COL_VIS: ColVisibility = {
  trace: true,
  time: true,
  annotations: true,
};
```

Derived rendering state:

```ts
const showGutter = !!process && traceFilters.events && colVis.trace;

const showTimeGutter =
  !!process &&
  colVis.time &&
  (traceFilters.time ||
    traceFilters.index ||
    traceFilters.line ||
    traceFilters.absLine ||
    traceFilters.debugTime ||
    traceFilters.refTime);

const showAnnotationGutter = !!process?.session_id && colVis.annotations;
```

`ColumnHeaderBar` is rendered only for the Claude pane. It provides quick hide
and show controls for trace and annotation columns and a hide control for the
time gutter.

### Bottom Ribbon

`TerminalBottomRibbon` is rendered for any process-backed terminal. It contains:

- A green/red status dot based on `process.status === ProcessStatus.RUNNING`.
- Queue controls and the next queued prompt preview.
- `Open Plan` when the latest plan annotation is available.
- Side-tab toggles for Shell, Git, Prompts, Queue, and Files.

The Shell side-tab creates or selects a sidecar plain shell. Creating a sidecar
shell builds a `Shell` entity with the current compute node and process working
directory, stores its id in `process.sidecar_shell_id`, saves the process, and
switches `activePane` to `shell`.

Closing the sidecar shell from `PaneBar` clears `process.sidecar_shell_id`,
saves the process, and returns to the Claude pane.

### PTY Lifecycle in the UI

`InteractiveTerminal` does not directly start the agent process in normal tab
rendering; process opening is handled by the loader and `AgenticProcess.start()`.
Once a `Shell` is available, the terminal:

- Initializes xterm.js and `PtySyncSession`.
- Replays buffered PTY chunks from `shell.getPtyChunks()`.
- Subscribes to live output through `shell.onOutput(...)`.
- Sends user keystrokes to `shell.sendInput(...)`.
- Resizes through `shell.resize(cols, rows)`.
- Rebuilds PTY sync state on resize and restart.

On process restart, the UI resets PTY sync state and asks the linked shell to
re-attach with `force: true`, which resets sequence/replay state in
`Shell.ptyConnection`.

---

## 6. PTY Mode vs CLI/Headless Mode

The same `AgenticProcess` class supports interactive PTY sessions and
CLI/headless execution. The toolbar belongs to the PTY path only.

| Area | PTY mode | CLI/headless mode |
|------|----------|-------------------|
| Entry point | `AgenticProcess.spawn(options, workerOptions)` without `headless: true`, or `process.start()` | `AgenticProcess.spawn(options, { headless: true, ... })`, `executeInstruction()`, or print-mode `prompt()` |
| UI | `InteractiveTerminal`, xterm.js, `ProcessToolbar`, gutters, bottom ribbon | No terminal UI or toolbar |
| Shell entity | Yes. `process.start()` opens/links a `Shell`, sets `shell_id`, `session_id`, and PTY id, then calls `Shell.attachPty(...)` | No shell is returned from the headless spawn path |
| Input | Raw terminal input through `Shell.sendInput(...)`; toolbar can inject text into the PTY | HTTP actions such as `executeInstruction()` or `prompt()` |
| CLI flags | Toolbar stages `process.cliOptions` changes and requires PTY restart | Set through `AgenticContext` / `cliOptions` before the headless run; no restart overlay |
| Restart | Toolbar calls `process.restart()` which stops and reopens the PTY | No restart button; callers use process APIs directly |
| Fork | Toolbar calls `process.fork(true)` and opens the new process as a visible PTY | Programmatic callers can create/resume/fork with spawn options, but no toolbar exists |
| Transcript | `process.session_id` identifies the Claude JSONL transcript and powers the transcript lens | Same transcript/session id model can be used without a PTY |
| Gutters and PTY Viewer | Available because PTY chunks and xterm rows exist | Not applicable |

The SDK split is visible in `AgenticProcess.spawn`:

```ts
if (workerOptions?.headless) {
  await process.watch();
  if (workerOptions.instruction) {
    await process.executeInstruction(workerOptions.instruction, {
      sync: workerOptions.sync ?? false,
      workerSessionId: workerOptions.workerSessionId,
    });
  }
  return { process, workerSessionId: workerOptions.workerSessionId };
}

await process.start({
  instruction: workerOptions?.instruction,
  ptyTimeout: workerOptions?.ptyTimeout,
});
return { process, shell: await process.shell(), workerSessionId: process.session_id };
```

Print-mode streaming is also headless-oriented: `AgenticProcess.prompt()` is for
`visible === false` processes created with `outputFormat: 'stream-json'`. PTY
interactive processes use terminal input, `inject`, or `executeInstruction`
instead.

`Shell` is the PTY owner. Its responsibilities include backend shell start,
PTY attach, output routing, input, resize, reconnect, close, and PTY sequence
fetching. None of those shell lifecycle controls are required for headless
execution.

---

## 7. Key Files Reference

| File | Role |
|------|------|
| `ui/src/components/terminal/interactive-terminal/ProcessToolbar.tsx` | Top toolbar, grouped CLI options, trace dropdown, session actions, timeout toast, overlay mounting |
| `ui/src/components/terminal/interactive-terminal/RestartRequiredOverlay.tsx` | Overlay UI for pending CLI option changes |
| `ui/src/components/terminal/interactive-terminal/WorktreeButtons.tsx` | Commit-and-merge and open-in-worktree controls |
| `ui/src/components/terminal/interactive-terminal/InteractiveTerminal.tsx` | ProcessToolbar mounting, xterm/PTYSYNC lifecycle, gutters, sidecar shell, bottom ribbon |
| `ui/src/components/terminal/interactive-terminal/ColumnHeaderBar.tsx` | Header controls for trace, time, and annotation columns |
| `ui/src/components/terminal/interactive-terminal/TerminalBottomRibbon.tsx` | Status dot, queue controls, plan button, side-tab toggles |
| `ts_sdk/src/process/agentic-process.ts` | `AgenticProcess` entity, `cliOptions`, `spawn`, `start`, `fork`, `restart`, `executeInstruction`, `prompt` |
| `ts_sdk/src/entities/shell.ts` | `Shell` entity and PTY lifecycle: start, attach, input, resize, reconnect, close |
| `ts_sdk/src/process/agentic-context.ts` | Spawn/context options, including `headless` worker options and `outputFormat` |
| `ts_sdk/src/process/agentic-types.ts` | `ProcessStatus`, `WorkerStatus`, `hasWorkerStarted`, and interactive vs CLI mode concepts |
| `ts_sdk/src/cli_workers/claude-cli.ts` | `ClaudeCliOptions` serialization and CLI argument construction |
| `ts_sdk/src/resource_management/fs_records/claude/claude-session.ts` | Transcript record discovery used by Open Transcript |
| `ui/src/navigation/useDockNavigation.ts` | Navigation methods used by toolbar actions |
