/**
 * A terminal never keeps output drawn for a grid its PTY never had (prod 2026-10-09).
 *
 * Prod "Git status" tab: Claude's screen drawn at 84 cols inside a 122-col xterm. The PTY's own
 * record (resize frames 134→96→134→122) replays clean at 122; the same bytes held at 84 then
 * widened reproduce the app's screen char for char. The xterm had been re-fitted to 84 and the PTY
 * never heard of it (the ResizeObserver fitted at once but sent 250ms later, and the send was
 * dropped when the tab went off screen first). Coming back re-sent 122 — the size the PTY already
 * had — which changes no winsize, sends no SIGWINCH, and redraws nothing.
 *
 * Fixed at the fit: fit and send move together. Guarded on return: an xterm that got output off
 * screen at a size the PTY doesn't have asks for a redraw (`repaint`).
 *
 * The REAL InteractiveTerminal under the headless-roundtrip harness: the xterm stand-in's grid
 * follows a controllable box through fit(), the ResizeObserver callback is captured, live bytes
 * enter through the attach hook's `write`, and the PTY is the list of sizes the view sent it.
 */
import { act, cleanup, render } from '@testing-library/react';
import { ProcessStatus, type AgenticProcess } from '@sdk';
import React from 'react';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// xterm — a stand-in whose grid follows the box through fit().
// ---------------------------------------------------------------------------
const xtermSpies = vi.hoisted(() => ({ lastTerm: null as { cols: number; rows: number } | null }));
// The xterm container's box, in cells: what fit() lands on.
const box = vi.hoisted(() => ({ cols: 122, rows: 40 }));

vi.mock('@xterm/xterm', () => {
  class Terminal {
    options: Record<string, unknown> = {};
    parser = { registerCsiHandler: () => ({ dispose() {} }) };
    rows = 40;
    cols = 122;
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
    write() {}
    reset() {}
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
    term: { cols: number; rows: number } | null = null;
    activate(t: { cols: number; rows: number }) {
      this.term = t;
    }
    // The grid follows the box, like the real addon.
    fit() {
      const t = xtermSpies.lastTerm;
      if (t) {
        t.cols = box.cols;
        t.rows = box.rows;
      }
    }
  },
}));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }));

// ---------------------------------------------------------------------------
// pty-sync — inert session so the real lifecycle effect can call initialize/
// dispose without a live adapter.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Peripheral chrome — not the unit under test; keep the mount tree light.
// ---------------------------------------------------------------------------
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
vi.mock('@src/components/terminal/interactive-terminal/ShellTerminal', () => ({
  ShellTerminal: () => null,
}));
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

// Gutter data hooks — inert.
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
vi.mock('@src/components/terminal/interactive-terminal/pty-replay', () => ({
  fetchPtyStream: () => Promise.resolve(null),
  replayPtyStream: () => Promise.resolve(null),
}));
// OSC 52 registration installs an OSC handler; the xterm stand-in exposes `registerCsiHandler` alone.
vi.mock('@src/components/terminal/interactive-terminal/terminalConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@src/components/terminal/interactive-terminal/terminalConfig')>()),
  registerOsc52ClipboardWrite: () => {},
}));

// App-level hooks/contexts — resolved, empty environment.
const EMPTY_WINDOWS = vi.hoisted<string[]>(() => []);
vi.mock('@src/hooks/useContext', () => ({
  useContext: () => ({ agenticProcessTypeId: null, agenticProcess: null }),
}));
vi.mock('@src/hooks/entity-hooks', () => ({ useEntity: () => ({ data: null }) }));
// The PTY: every size the view sends it, and whether it asked for a redraw.
const pty = vi.hoisted(() => ({
  resizes: [] as { cols: number; rows: number; repaint: boolean }[],
  fail: false, // the next send fails (resolves false), as a dropped WS request does
}));
const fakeShell = vi.hoisted(() => ({
  resize: (cols: number, rows: number, opts: { repaint?: boolean } = {}) => {
    pty.resizes.push({ cols, rows, repaint: opts.repaint === true });
    return Promise.resolve(!pty.fail);
  },
  releaseSize: () => {},
  on: () => () => {},
  getPtyChunks: () => [],
}));
vi.mock('@src/hooks/useShell', () => ({ useShell: () => ({ shell: fakeShell }) }));
// Live PTY output reaches the view through the attach hook's `write` — captured so the test can
// stream bytes in, as the WS does, while the view is on or off screen.
const attach = vi.hoisted(() => ({ write: null as ((d: string) => void) | null }));
vi.mock('@src/components/terminal/useXtermShellAttach', () => ({
  useXtermShellAttach: (_s: unknown, _t: unknown, opts: { write?: (d: string) => void }) => {
    attach.write = opts.write ?? null;
  },
}));
vi.mock('@src/hooks/use-instance-preferences', () => ({ useInstancePreferences: () => ({ preferences: {} }) }));
vi.mock('@src/hooks/use-preference', () => {
  const tuples = new Map<string, [Record<string, never>, () => void]>();
  return {
    // Resolved: the surface reconcile only acts once the mode is known.
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
// On the terminal surface unless a test moves it, so in the transport round trip only the
// pty_mode flip moves the view.
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

// jsdom reports 0x0 layout; the init path waits for real dimensions before
// opening xterm, so give every element a nonzero box for this file.
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

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});



const mockProcess = {
  id: '0b54c9f6-8f6e-4f0a-9a4e-2f0d64f7c111',
  typeId: null,
  status: ProcessStatus.RUNNING,
  busy: false,
  session_id: 'shell-sess-1',
  worker_type: 'claude',
  workdir: '/tmp/proj',
  project_id: null,
  plan_path: null,
  sidecar_shell_id: null,
  shell_id: null,
  markdown_docs: [],
  artifacts: [],
  loadArtifacts: () => Promise.resolve([]),
  applyArtifactEvent: () => false,
  pty_mode: true,
  isHeadless: false,
  getPlan: () => Promise.resolve(null),
  onPlan: () => () => {},
  on: () => {},
  off: () => {},
  watch: () => Promise.resolve(() => Promise.resolve()),
  loadHistory: () => Promise.resolve(),
} as unknown as AgenticProcess;

const ui = (active: boolean, marker: string) => (
  <MemoryRouter>
    <InteractiveTerminal sessionId="shell-sess-1" active={active} process={mockProcess} className={marker} />
  </MemoryRouter>
);

// The container's ResizeObserver: the callback the layout change fires.
let observed: (() => void) | null = null;
const CELL_PX = 8;

/** Run every deferred step: fit timers, frames, the 250ms resize debounce. */
const flush = (ms = 400) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

/** The layout moves the box; the observer sees it. */
const layout = (cols: number) => {
  box.cols = cols;
  act(() => observed?.());
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'] });
  box.cols = 122;
  box.rows = 40;
  pty.resizes.length = 0;
  pty.fail = false;
  attach.write = null;
  observed = null;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        observed = cb;
      }
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => box.cols * CELL_PX, configurable: true });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => box.rows * 16, configurable: true });
});

const last = () => pty.resizes[pty.resizes.length - 1];

describe('InteractiveTerminal — the xterm never keeps output drawn for a grid the PTY never had', () => {
  it('the pane narrows and the tab leaves within the debounce: the xterm is not re-fitted, so nothing drifts', () => {
    const { rerender } = render(ui(true, 'a'));
    flush();
    expect(last()).toEqual({ cols: 122, rows: 40, repaint: false }); // on screen, synced at 122

    // The pane narrows (a side panel opens) and the tab goes off screen before the 250ms debounce.
    layout(84);
    rerender(ui(false, 'b'));
    flush();
    // Fit and send move together: neither happened, so the xterm stays on the PTY's grid.
    expect(xtermSpies.lastTerm?.cols).toBe(122);
    expect(pty.resizes.some((r) => r.cols === 84)).toBe(false);

    act(() => attach.write?.('\x1b[2J\x1b[Hframe drawn for 122 columns'));
    // Back on screen in the narrow pane: fit + send 84 together — a real resize, so a real redraw.
    rerender(ui(true, 'c'));
    flush();
    expect(last()).toEqual({ cols: 84, rows: 40, repaint: false });
  });

  it('a size the PTY never got, then output off screen: the return asks for a redraw', async () => {
    const { rerender } = render(ui(true, 'a'));
    flush();
    // The pane narrows on screen; the send of 84 fails (the PTY keeps 122) — the xterm is at 84.
    pty.fail = true;
    layout(84);
    flush();
    await act(async () => {}); // the failed send settles
    pty.fail = false;
    expect(xtermSpies.lastTerm?.cols).toBe(84);

    rerender(ui(false, 'b'));
    flush();
    // Claude keeps writing for the PTY's 122 cols into the 84-col xterm.
    act(() => attach.write?.('\x1b[2J\x1b[Hframe drawn for 122 columns'));

    // Back on screen at 122 — the PTY's own size, a no-op winsize change: only `repaint` redraws.
    box.cols = 122;
    rerender(ui(true, 'c'));
    flush();
    expect(last()).toEqual({ cols: 122, rows: 40, repaint: true });
  });

  it('a plain tab switch with nothing drifted stays a plain resize (no redraw on every switch)', () => {
    const { rerender } = render(ui(true, 'a'));
    flush();
    rerender(ui(false, 'b'));
    flush();
    act(() => attach.write?.('output while hidden, at the grid the PTY has'));
    rerender(ui(true, 'c'));
    flush();
    expect(last()).toEqual({ cols: 122, rows: 40, repaint: false });
  });

  it('with the window hidden a layout change is not fitted: the xterm keeps the grid the PTY has', () => {
    render(ui(true, 'a'));
    flush();
    // The active tab, but the window is hidden (minimized / another Space): it cannot size the PTY,
    // so a fit here would leave the xterm on a grid the PTY never gets.
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      layout(84);
      flush();
      expect(xtermSpies.lastTerm?.cols).toBe(122);
      expect(pty.resizes.some((r) => r.cols === 84)).toBe(false);
    } finally {
      vis.mockRestore();
    }
  });
});
