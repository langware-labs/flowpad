/**
 * An agent terminal lets go of what only a LIVE session needs when its process ends (B9).
 *
 * The view's process watch, the shell's live-output subscription and the shell's chunk window
 * were all acquired on mount and released only on unmount — and an agent exiting on its own
 * changes nothing a mount is keyed on, so a finished tab left open pinned all three for as
 * long as the page lived. Now process liveness is part of the view's lifecycle: the `stopped`
 * save the backend makes after the PTY exits reaches the mounted panel as an entity update and
 * runs the same release the unmount runs, while the xterm keeps the final screen; a restart
 * attaches and watches again.
 *
 * The REAL InteractiveTerminal, the real attach hook, a real `Shell` + `PtyConnection`, a real
 * `AgenticProcess` in the real store (the status enters through the store's own data-op path,
 * as the WS delivers it). The xterm is a stand-in that records what was written; the recorded
 * stream answers "none"; peripheral chrome is stubbed as the width-drift harness does.
 */
import { act, cleanup, render } from '@testing-library/react';
import { AgenticProcess, apiClient, dataManager, ProcessStatus, Shell, TypeId } from '@sdk';
import React from 'react';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasLaunchWatch, holdLaunchWatch, releaseLaunchWatch } from '@src/components/agents/launch-watch';

// ---------------------------------------------------------------------------
// xterm — a stand-in that records every write and reset.
// ---------------------------------------------------------------------------
const xtermSpies = vi.hoisted(() => ({
  lastTerm: null as { cols: number; rows: number; written: string[]; resets: number } | null,
}));
vi.mock('@xterm/xterm', () => {
  class Terminal {
    options: Record<string, unknown> = {};
    parser = { registerCsiHandler: () => ({ dispose() {} }) };
    rows = 40;
    cols = 122;
    written: string[] = [];
    resets = 0;
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    registerLinkProvider() {
      return { dispose() {} };
    }
    open() {
      xtermSpies.lastTerm = this;
    }
    onTitleChange() {
      return { dispose() {} };
    }
    onData() {
      return { dispose() {} };
    }
    write(d: string, cb?: () => void) {
      if (d) this.written.push(d);
      cb?.();
    }
    reset() {
      this.resets++;
    }
    refresh() {}
    scrollToBottom() {}
    focus() {}
    hasSelection() {
      return false;
    }
    getSelection() {
      return '';
    }
    clearSelection() {}
    dispose() {}
  }
  return { Terminal };
});
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    activate() {}
    fit() {}
  },
}));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }));

// pty-sync — inert session; the real lifecycle effect calls initialize/dispose.
const PTY_SNAPSHOT = vi.hoisted(() => ({ adapter: null, vt: null, refLines: [], version: 0 }));
vi.mock('@sdk/pty-sync/PtySyncSession.js', () => ({
  PtySyncSession: class {
    initialize() {}
    getSnapshot() {
      return PTY_SNAPSHOT;
    }
    initSegments() {}
    notifyBufferReady() {}
    processChunk() {}
    resetSession() {}
    dispose() {}
    subscribe() {
      return () => {};
    }
  },
}));
vi.mock('@sdk/pty-sync/ui/useScrollSync.js', () => ({ useScrollSync: () => null }));
vi.mock('@sdk/pty-sync/ui/XTermHarness.js', () => ({
  XTermHarness: class {
    setHoverHighlight() {}
  },
}));
vi.mock('@src/components/terminal/interactive-terminal/PtySyncContext', () => ({
  PtySyncProvider: ({ children }: { children: React.ReactNode }) => children,
  usePtySyncSession: () => PTY_SNAPSHOT,
}));

// Peripheral chrome — not the unit under test.
vi.mock('@src/components/terminal/interactive-terminal/ProcessToolbar', () => ({ ProcessToolbar: () => null }));
vi.mock('@src/components/terminal/interactive-terminal/SimpleChatPane', () => ({ SimpleChatPane: () => null }));
vi.mock('@src/components/terminal/interactive-terminal/ChatComposerBar', () => ({ ChatComposerBar: () => null }));
vi.mock('@src/components/terminal/interactive-terminal/TerminalBottomRibbon', () => ({
  TerminalBottomRibbon: () => null,
}));
vi.mock('@src/components/terminal/interactive-terminal/ColumnHeaderBar', () => ({ ColumnHeaderBar: () => null }));
vi.mock('@src/components/terminal/interactive-terminal/PaneBar', () => ({ PaneBar: () => null }));
vi.mock('@src/components/terminal/interactive-terminal/PaneSelectorBar', () => ({ PaneSelectorBar: () => null }));
vi.mock('@src/components/terminal/interactive-terminal/PaneView', () => ({ PaneView: () => null }));
vi.mock('@src/components/terminal/interactive-terminal/ShellTerminal', () => ({ ShellTerminal: () => null }));
vi.mock('@src/components/terminal/interactive-terminal/TerminalSearchBar', () => ({ TerminalSearchBar: () => null }));
vi.mock('@src/components/terminal/interactive-terminal/TerminalRuntimeErrorBanner', () => ({
  TerminalRuntimeErrorBanner: () => null,
}));
vi.mock('@src/components/terminal/interactive-terminal/TraceGutter', () => ({ TraceGutter: () => null }));
vi.mock('@src/components/terminal/interactive-terminal/TimeGutter', () => ({
  TimeGutter: () => null,
  calcTimeGutterWidth: () => 0,
}));
vi.mock('@src/components/terminal/interactive-terminal/AnnotationGutter', () => ({ AnnotationGutter: () => null }));
vi.mock('@src/components/terminal/interactive-terminal/LastPromptTooltip', () => ({
  SideTabTooltipContent: () => null,
}));
vi.mock('@src/components/terminal/interactive-terminal/chat-plan-mode-context', () => ({
  ChatPlanModeProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@src/components/ui/side-drawer', () => ({ TabbedSideDrawer: () => null }));
vi.mock('@src/components/entity-context', () => ({ EntityContextPanel: () => null }));
vi.mock('@src/components/terminal/interactive-terminal/side-windows', async () => {
  const types = await import('@src/components/terminal/interactive-terminal/side-windows/SideWindowTypes');
  return {
    ...types,
    GitPanel: () => null,
    PromptIndexPanel: () => null,
    InputFilesPanel: () => null,
    AnalysisPanel: () => null,
    QueuePanel: () => null,
    SimpleDirTree: () => null,
    SkillsAgentsPanel: () => null,
    usePromptsForProcess: () => ({ transcriptPrompts: [], refresh: () => {} }),
  };
});
vi.mock('@src/components/terminal/interactive-terminal/use-trace-gutter', () => ({
  useTraceGutter: () => ({
    entries: [],
    totalTraceEvents: 0,
    historicalCount: 0,
    liveCount: 0,
    sessionStartTime: null,
    allEvents: [],
  }),
}));
vi.mock('@src/components/terminal/interactive-terminal/use-annotation-gutter', () => ({
  getAnchors: () => [],
  useAnnotationGutter: () => ({
    elements: [],
    createBookmark: () => {},
    createComment: () => {},
    deleteBookmark: () => {},
    pendingScrollLine: null,
    sessionAnnotations: [],
  }),
}));
vi.mock('@src/components/terminal/interactive-terminal/use-time-gutter', () => ({ useTimeGutter: () => [] }));
// No recording: the attach is live-only (history null), as a legacy session's is.
vi.mock('@src/components/terminal/interactive-terminal/pty-replay', () => ({
  fetchPtyStream: () => Promise.resolve(null),
  replayPtyStream: () => Promise.resolve(null),
  saveReplayCheckpoint: () => {},
}));
vi.mock('@src/components/terminal/interactive-terminal/terminalConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@src/components/terminal/interactive-terminal/terminalConfig')>()),
  registerOsc52ClipboardWrite: () => {},
}));

// App-level hooks/contexts — resolved, empty environment. `useEntity` stays REAL: it reads the
// seeded store and subscribes to it, which is how the exit reaches the view.
const EMPTY_WINDOWS = vi.hoisted<string[]>(() => []);
vi.mock('@src/hooks/useContext', () => ({
  useContext: () => ({ agenticProcessTypeId: null, agenticProcess: null }),
}));
// The shell under the view: the real entity, handed over without the cache-retry walk.
const live = vi.hoisted(() => ({ shell: null as unknown }));
vi.mock('@src/hooks/useShell', () => ({ useShell: () => ({ shell: live.shell, connected: true }) }));
vi.mock('@src/hooks/use-instance-preferences', () => ({ useInstancePreferences: () => ({ preferences: {} }) }));
vi.mock('@src/hooks/use-preference', () => {
  const tuples = new Map<string, [Record<string, never>, () => void]>();
  return {
    usePreferenceResolved: () => true,
    usePreference: (key: string) => {
      if (!tuples.has(key)) tuples.set(key, [{}, () => {}]);
      return tuples.get(key);
    },
  };
});
vi.mock('@src/hooks/useFS', () => ({ useFS: () => null }));
vi.mock('@src/hooks/use-input-dir', () => ({ useInputDir: () => null }));
vi.mock('@src/navigation', () => ({
  DockPointer: class {},
  useDockNavigation: () => ({ navigation: {}, currentDock: null }),
  useSideWindows: () => ({
    windows: EMPTY_WINDOWS,
    active: null,
    open: () => {},
    close: () => {},
    select: () => {},
    toggle: () => {},
  }),
}));
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('@src/components/view-mode', () => ({ useIsAdvanced: () => true }));
vi.mock('@src/contexts/view-mode-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@src/contexts/view-mode-context')>()),
  useSessionSurface: () => 'terminal',
  useViewMode: () => 'advanced',
}));
vi.mock('@src/notifications/notify', () => ({
  notify: { error: () => {}, success: () => {}, info: () => {}, warning: () => {} },
}));
vi.mock('@src/components/image-annotator/annotate-files', () => ({
  annotateImageFiles: (files: File[]) => Promise.resolve({ files, caption: '' }),
}));

import InteractiveTerminal from '@src/components/terminal/interactive-terminal/InteractiveTerminal';

const PROCESS_ID = '0b54c9f6-8f6e-4f0a-9a4e-2f0d64f7c9b9';
const SHELL_ID = '3c7e1f20-5d1a-4b7e-9c3a-7f2b9e0a1b9c';
const NODE_ID = '11111111-2222-4333-8444-555555555555';
const processTypeId = new TypeId(AgenticProcess.type, PROCESS_ID);
const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64');

// jsdom reports 0x0 layout; the init path waits for real dimensions before opening xterm.
const dimensionProps: PropertyDescriptorMap = {
  offsetWidth: { get: () => 800, configurable: true },
  offsetHeight: { get: () => 600, configurable: true },
};
let savedOffsetWidth: PropertyDescriptor | undefined;
let savedOffsetHeight: PropertyDescriptor | undefined;
beforeAll(() => {
  savedOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  savedOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperties(HTMLElement.prototype, dimensionProps);
});
afterAll(() => {
  if (savedOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', savedOffsetWidth);
  if (savedOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', savedOffsetHeight);
});

type Store = {
  getRef(t: TypeId): { entity: unknown; status: string };
  onDataOp(t: string, op: string, d: object): void;
  watches: { get(t: TypeId): number | undefined };
};
const store = dataManager as unknown as Store;
let post: ReturnType<typeof vi.spyOn<typeof apiClient, 'post'>>;

/** The process, seeded in the real store the way a loader leaves it. */
function seedProcess(status: ProcessStatus): AgenticProcess {
  const proc = new AgenticProcess({
    id: PROCESS_ID,
    status,
    shell_id: SHELL_ID,
    pty_mode: true,
    workdir: '/tmp/proj',
    worker_type: 'claude',
  } as never);
  const ref = store.getRef(processTypeId);
  ref.entity = proc;
  ref.status = 'READY';
  return proc;
}

/** The backend's save after the PTY exited (or a restart), as the store applies the WS op. */
const deliverStatus = (status: ProcessStatus) =>
  act(() => store.onDataOp(processTypeId.toString(), 'update', { type: AgenticProcess.type, id: PROCESS_ID, status }));

/** A shell whose PTY is attached, as the loader's open leaves it. */
function attachedShell(): Shell {
  const shell = new Shell({ id: SHELL_ID, compute_node_id: NODE_ID });
  const pc = shell.ptyConnection as unknown as { _attached: boolean; _started: boolean };
  pc._attached = true;
  vi.spyOn(shell, 'resize').mockResolvedValue(undefined as never);
  return shell;
}

const listeners = (shell: Shell) => (shell.ptyConnection as unknown as { _listeners: Set<unknown> })._listeners.size;
const viewWatch = () => store.watches.get(processTypeId) ?? 0;
const flush = () => act(() => void vi.advanceTimersByTime(400));
const settle = () => act(async () => {});

const ui = (proc: AgenticProcess) => (
  <MemoryRouter>
    <InteractiveTerminal sessionId={SHELL_ID} active process={proc} />
  </MemoryRouter>
);

beforeEach(async () => {
  await dataManager.clearCache();
  releaseLaunchWatch(PROCESS_ID);
  vi.spyOn(apiClient, 'get').mockResolvedValue(null as never);
  post = vi.spyOn(apiClient, 'post').mockResolvedValue(undefined as never);
  vi.spyOn(dataManager, 'callAction').mockResolvedValue({} as never);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  xtermSpies.lastTerm = null;
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Mount on a running process and let the attach finish: live output flows to the xterm. */
async function mountLive() {
  const shell = attachedShell();
  live.shell = shell;
  const proc = seedProcess(ProcessStatus.RUNNING);
  const view = render(ui(proc));
  flush(); // xterm opens, the view is ready, the attach hook is listening
  expect(xtermSpies.lastTerm).not.toBeNull();
  // The PTY reports connected (no socket here, so the shell says so itself).
  act(() => void shell.emit('status', 'connected'));
  await settle(); // the (empty) recording answers; the output subscription is taken
  expect(listeners(shell)).toBe(1);
  expect(viewWatch()).toBe(1);
  shell.ptyConnection.appendOutput(b64('mock> flood\r\n'), 1);
  shell.ptyConnection.appendOutput(b64('mock line 0000001\r\n'), 2);
  expect(xtermSpies.lastTerm?.written.at(-1)).toBe('mock line 0000001\r\n');
  expect(shell.getPtyChunks()).toHaveLength(2);
  return { shell, proc, view };
}

describe('InteractiveTerminal — a process that ended holds nothing a live session needs', () => {
  it('on exit: the watch is given back, live output is unsubscribed, the window is let go, the screen stays', async () => {
    const { shell } = await mountLive();
    const resetsBefore = xtermSpies.lastTerm!.resets;

    deliverStatus(ProcessStatus.STOPPED);
    await settle();

    expect(viewWatch()).toBe(0);
    expect(listeners(shell)).toBe(0);
    expect(shell.getPtyChunks()).toHaveLength(0);
    // The xterm was not reset or cleared: the final screen is what the user still sees.
    expect(xtermSpies.lastTerm!.resets).toBe(resetsBefore);
    expect(xtermSpies.lastTerm!.written).toContain('mock line 0000001\r\n');
    // Output after the exit (none is expected, but a trailing frame must not revive the view).
    shell.ptyConnection.appendOutput(b64('late\r\n'), 3);
    expect(xtermSpies.lastTerm!.written).not.toContain('late\r\n');
  });

  it('the launch-time lease goes with the view watch, so the process is no longer watched at all', async () => {
    const { proc } = await mountLive();
    holdLaunchWatch(proc);
    await settle();
    expect(viewWatch()).toBe(2);

    deliverStatus(ProcessStatus.STOPPED);
    await settle();

    expect(hasLaunchWatch(PROCESS_ID)).toBe(false);
    expect(viewWatch()).toBe(0);
    // No socket here, so the store sends nothing: the count reaching zero is the fact.
    expect(post.mock.calls.filter(([u]) => String(u).endsWith('/unwatch'))).toHaveLength(0);
  });

  it('a restart attaches and watches again, and new output reaches the screen', async () => {
    const { shell } = await mountLive();
    deliverStatus(ProcessStatus.STOPPED);
    await settle();
    expect(listeners(shell)).toBe(0);

    deliverStatus(ProcessStatus.STARTING);
    await settle();
    // The PTY comes up: the shell reports connected, the attach runs as on a mount.
    act(() => void shell.emit('status', 'connected'));
    await settle();

    expect(viewWatch()).toBe(1);
    expect(listeners(shell)).toBe(1);
    shell.ptyConnection.appendOutput(b64('mock> again\r\n'), 3);
    expect(xtermSpies.lastTerm?.written.at(-1)).toBe('mock> again\r\n');
    expect(shell.getPtyChunks()).toHaveLength(1);
  });

  it('a failed start is an end too; a Retry re-acquires', async () => {
    const { shell } = await mountLive();
    deliverStatus(ProcessStatus.FAILED);
    await settle();
    expect(viewWatch()).toBe(0);
    expect(listeners(shell)).toBe(0);

    deliverStatus(ProcessStatus.STARTING);
    await settle();
    expect(viewWatch()).toBe(1);
  });

  it('closing the tab after the exit releases nothing twice and leaves no watch', async () => {
    const { view, shell } = await mountLive();
    deliverStatus(ProcessStatus.STOPPED);
    await settle();

    view.unmount();
    await settle();
    expect(viewWatch()).toBe(0);
    expect(listeners(shell)).toBe(0);
  });
});
