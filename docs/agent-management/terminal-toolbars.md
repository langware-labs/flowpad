---
id: 502000ee-9748-50be-8a2e-8f334b278ae2
---

# Terminal Toolbars

Reference for the current terminal toolbar and session controls in the frontend.

This document describes the interactive PTY terminal UI. The same
`AgenticProcess` entity can also run in CLI/headless mode, but headless mode
does not render `InteractiveTerminal`, `ProcessToolbar`, xterm.js, gutters, or
the Restart button. See [PTY Mode vs CLI/Headless Mode](#6-pty-mode-vs-cliheadless-mode).

---

## Table of Contents

1. [Component Hierarchy](#1-component-hierarchy)
2. [ProcessToolbar](#2-processtoolbar)
3. [Controls Reference](#3-controls-reference)
   - [CLI Options Dropdown](#31-cli-options-dropdown)
   - [Columns & Trace Dropdown](#32-columns--trace-dropdown)
   - [Session Actions](#33-session-actions)
   - [API Timeout Toast](#34-api-timeout-toast)
4. [Restart Required Signal](#4-restart-required-signal)
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
  |     |-- WorktreeButtons.tsx          (worktree-specific actions)
  |     `-- PTYViewer                    (opened from Columns & Trace)
  |-- PaneBar.tsx                        (sidecar shell pane top bar)
  |-- ColumnHeaderBar.tsx                (trace/time/annotation column headers)
  |-- TraceGutter.tsx
  |-- TimeGutter.tsx
  |-- AnnotationGutter.tsx
  |-- side-windows/*                     (GitPanel, PromptIndexPanel, QueuePanel, AnalysisPanel,
  |                                       SkillsAgentsPanel, InputFilesPanel, SimpleDirTree)
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

// started: process is live RIGHT NOW (gates Restart, CLI flag toggles)
const started = isProcessRunning(process.status);
// hasTranscript: at least one real assistant turn happened (gates Fork, Open Transcript)
const hasTranscript = hasSession && hasWorkerStarted(workerStatus) && workerStatus !== WorkerStatus.IDLE;
const canFork = hasTranscript;
const canToggle = started;
const workdir = process.workdir ?? '';

const cliCapabilities = getWorkerCliCapabilities(process.worker_type);
const _cliOpts = process.cliOptions;
const currentChrome = cliCapabilities.chrome && _cliOpts.chrome;
const currentDanger = cliCapabilities.fullTrust && _cliOpts.permission_mode === 'bypassPermissions';
const currentDebug = cliCapabilities.debug && _cliOpts.debug;
```

`isProcessRunning` (`ts_sdk/src/process/agentic-types.ts`) is true for
`STARTING`, `RUNNING`, and `STOPPING`. `getWorkerCliCapabilities`
(`process-cli-presentation.ts`) says which flags the process's worker vendor
supports; an unsupported flag reads as off and its checkbox is not rendered.

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
| Active when | Any supported CLI option is enabled: Chrome, Full Trust, or Debug |
| Rendered when | The worker vendor supports at least one of the three flags |
| Disabled items when | `!isProcessRunning(process.status)` |
| Applies to | PTY mode only |

The dropdown contains up to three `RichCheckboxItem` controls, each rendered only
when `cliCapabilities` supports it:

| Label | Source | Shown when | CLI effect |
|-------|--------|------------|------------|
| Chrome browser | `process.cliOptions.chrome` | `cliCapabilities.chrome` | Adds `--chrome` |
| Full Trust | `process.cliOptions.permission_mode === 'bypassPermissions'` | `cliCapabilities.fullTrust` | Adds `--dangerously-skip-permissions` when true; stores `askUser` when false |
| Debug logging | `process.cliOptions.debug` | `cliCapabilities.debug` | Adds `--debug` |

Changing a checkbox writes straight to the entity: `persistCliFlags` updates
`process.cliOptions` and saves the process. It does not restart the PTY.

```ts
const persistCliFlags = useCallback(
  async (overrides: { chrome?: boolean; danger?: boolean; debug?: boolean }) => {
    if (!canToggle) return;
    const cli = process.cliOptions;
    if (overrides.chrome !== undefined) cli.chrome = overrides.chrome;
    if (overrides.danger !== undefined) cli.permission_mode = overrides.danger ? 'bypassPermissions' : 'askUser';
    if (overrides.debug !== undefined) cli.debug = overrides.debug;
    process.cliOptions = cli;
    await process.save();
  },
  [process, canToggle],
);
```

The backend then flips `process.restart_required`, and the Restart button glows
until the user restarts (see [Restart Required Signal](#4-restart-required-signal)).

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
Restart button because there is no live xterm/Shell PTY to restart from the UI.

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

`InteractiveTerminal` persists these UI preferences through the preference
registry (`ts_sdk/src/preferences/prefRegistry.ts`), not raw local storage:

```ts
const [traceFilters, setTraceFilters] = usePreference<TraceFilters>(PrefKey.TRACE_FILTERS);
const [colVis, setColVis] = usePreference<ColVisibility>(PrefKey.COLUMN_VISIBILITY);
```

The keys are `preferences.terminal.trace_filters` and
`preferences.terminal.column_visibility`. The old `traceFilters` /
`colVisibility` local-storage keys survive only as each entry's
`legacyLocalStorageKey`.

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
    permissionMode: (process.cliOptions.permission_mode as 'bypassPermissions' | 'askUser') ?? 'askUser',
  },
  { visible: true },
);
navigation.openDock(newProcess.terminalDockPointer);
```

This is a PTY flow: `AgenticProcess.spawn` without `headless: true` calls
`process.start()` and links a `Shell`.

#### Restart

| Property | Current behavior |
|----------|------------------|
| Icon | `RotateCcw` |
| Disabled when | `!isProcessRunning(process.status)` or `isRestarting` |
| Glows when | `process.restart_required && started` (also sets `aria-pressed`) |
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

The session history is preserved through `process.session_id`. CLI option
changes are already saved by the dropdown; the Restart button only relaunches
the PTY so they take effect.

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
| Handler | Open the transcript lens for the process's vendor |

Clicking opens the transcript lens directly. The lens category comes from the
process (`claude`, `codex`, `copilot`, or `opencode`, derived from
`worker_type`), never a literal, and the path is the bare session id:

```ts
navigation.openLens(process.transcriptLensCategory, 'transcript', process.session_id!);
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

## 4. Restart Required Signal

There is no restart overlay and no staged (pending) CLI state. Restart awareness
is backend-driven: any worker-relevant change (including a CLI flag saved from
the dropdown) flips `process.restart_required`, and the top-bar Restart button
in `ProcessToolbar.tsx` reflects it:

```tsx
<button
  data-testid="process-toolbar-restart"
  data-restart-required={process.restart_required ? 'true' : 'false'}
  disabled={!started || isRestarting}
  onClick={() => void handleRestart()}
  aria-pressed={process.restart_required}
  aria-label={t`Restart session`}
>
```

While `process.restart_required && started`, the button pulses amber and its
tooltip reads `Restart required — config changed since start`. Otherwise the
tooltip reads `Restarting…`, `Session is not running`, or `Restart session`.
The toolbar re-renders on the flag through `useSyncExternalStore` over
`dataManager.subscribe(process.typeId, …)`.

Nothing blocks terminal interaction: the user keeps working and restarts when
ready. Clicking calls `process.restart()` (see [Restart](#restart)).

---

## 5. InteractiveTerminal State

**File**: `ui/src/components/terminal/interactive-terminal/InteractiveTerminal.tsx`

### Trace and Column State

`InteractiveTerminal` owns trace and column preferences and passes them into
`ProcessToolbar`. Their defaults are the preference-registry entries in
`ts_sdk/src/preferences/prefRegistry.ts` (an unset trace field reads as off):

```ts
[PrefKey.TRACE_FILTERS]: {
  key: PrefKey.TRACE_FILTERS,
  legacyLocalStorageKey: 'traceFilters',
  category: 'terminal',
  label: 'Trace filters',
  dataType: PrefDataType.JSON,
  defaultValue: { events: true },
},
[PrefKey.COLUMN_VISIBILITY]: {
  key: PrefKey.COLUMN_VISIBILITY,
  legacyLocalStorageKey: 'colVisibility',
  category: 'terminal',
  label: 'Column visibility',
  dataType: PrefDataType.JSON,
  defaultValue: { trace: true, time: true, annotations: true },
},
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

const showAnnotationGutter = isAdvanced && !!process?.session_id && colVis.annotations;
```

The annotation gutter is an advanced-view feature; `isAdvanced` is false in the
standard view mode.

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
| CLI flags | Toolbar saves `process.cliOptions` changes; `restart_required` asks for a PTY restart | Set through `AgenticContext` / `cliOptions` before the headless run; no Restart button |
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
  visible: workerOptions?.visible,
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
| `ui/src/components/terminal/interactive-terminal/ProcessToolbar.tsx` | Top toolbar, grouped CLI options, trace dropdown, session actions, `restart_required` Restart button |
| `ui/src/components/terminal/interactive-terminal/process-cli-presentation.ts` | `getWorkerCliCapabilities`: which CLI flags a worker vendor supports |
| `ui/src/components/terminal/interactive-terminal/WorktreeButtons.tsx` | Commit-and-merge and open-in-worktree controls |
| `ui/src/components/terminal/interactive-terminal/InteractiveTerminal.tsx` | ProcessToolbar mounting, xterm/PTYSYNC lifecycle, gutters, sidecar shell, bottom ribbon |
| `ui/src/components/terminal/interactive-terminal/ColumnHeaderBar.tsx` | Header controls for trace, time, and annotation columns |
| `ui/src/components/terminal/interactive-terminal/TerminalBottomRibbon.tsx` | Status dot, queue controls, plan button, side-tab toggles |
| `ts_sdk/src/process/agentic-process.ts` | `AgenticProcess` entity, `cliOptions`, `spawn`, `start`, `fork`, `restart`, `executeInstruction`, `prompt` |
| `ts_sdk/src/entities/shell.ts` | `Shell` entity and PTY lifecycle: start, attach, input, resize, reconnect, close |
| `ts_sdk/src/process/agentic-context.ts` | Spawn/context options, including `headless` worker options and `outputFormat` |
| `ts_sdk/src/process/agentic-types.ts` | `ProcessStatus`, `WorkerStatus`, `hasWorkerStarted`, and interactive vs CLI mode concepts |
| `ts_sdk/src/cli_workers/claude-cli.ts` | `ClaudeAgentOptions` serialization and CLI argument construction |
| `ts_sdk/src/resource_management/fs_records/claude/claude-session.ts` | Transcript record discovery used by Open Transcript |
| `ui/src/navigation/useDockNavigation.ts` | Navigation methods used by toolbar actions |
