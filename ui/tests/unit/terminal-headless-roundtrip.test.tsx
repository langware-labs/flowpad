/**
 * Regression (C11 — blank terminal after a chat⇄terminal round trip):
 *
 * The xterm container div is only rendered while `!process.isHeadless`
 * (pty_mode transport). Switching terminal→chat (pty_mode=false) unmounts the
 * container; switching back re-mounts a FRESH div. The terminal init/dispose
 * useLayoutEffect used to depend on `[sessionId]` only — sessionId doesn't
 * change across the round trip, so the effect never re-ran: the old XTerm
 * stayed attached to the removed div and the new container was never opened
 * into. Result: pty_mode=true on the API but BOTH the .xterm and the chat pane
 * absent — a blank window. The fix keys the effect on `[sessionId, isHeadless]`
 * so the round trip disposes on unmount and re-initializes on re-mount.
 *
 * This test renders the REAL InteractiveTerminal (heavy peripherals mocked,
 * lifecycle path real) and flips isHeadless false→true→false, asserting the
 * xterm open/init path runs again on the way back. It fails with the pre-fix
 * `[sessionId]` dependency array (open stays at 1) and passes with the fix.
 *
 * Note the tri-state skin: the Standard-view chat OVERLAY (chatUiOverride)
 * deliberately keeps the xterm mounted underneath (same `!isHeadless` gate),
 * so only the pty_mode TRANSPORT flip exercises this unmount/remount path.
 */
import { act, cleanup, render } from '@testing-library/react';
import { ProcessStatus, type AgenticProcess } from '@sdk';
import React from 'react';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// xterm — a spy-instrumented stand-in. `open` is the observable "the terminal
// actually attached to the DOM container" signal the regression is about.
// ---------------------------------------------------------------------------
const xtermSpies = vi.hoisted(() => ({
  open: { calls: 0, lastContainer: null as HTMLElement | null },
  dispose: { calls: 0 },
}));

vi.mock('@xterm/xterm', () => {
  class Terminal {
    options: Record<string, unknown> = {};
    parser = { registerCsiHandler: () => ({ dispose() {} }) };
    rows = 24;
    cols = 80;
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    open(el: HTMLElement) {
      xtermSpies.open.calls += 1;
      xtermSpies.open.lastContainer = el;
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
    dispose() {
      xtermSpies.dispose.calls += 1;
    }
  }
  return { Terminal };
});
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));

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
// Peripheral chrome — not the unit under test; keep the mount tree light. The
// SimpleChatPane stub is observable so we can assert the headless leg really
// swapped views.
// ---------------------------------------------------------------------------
vi.mock('@src/components/terminal/interactive-terminal/ProcessToolbar', () => ({ ProcessToolbar: () => null }));
vi.mock('@src/components/terminal/interactive-terminal/SimpleChatPane', () => ({
  SimpleChatPane: () => <div data-testid="simple-chat" />,
}));
vi.mock('@src/components/terminal/interactive-terminal/ChatComposerBar', () => ({ ChatComposerBar: () => null }));
vi.mock('@src/components/terminal/interactive-terminal/TerminalBottomRibbon', () => ({
  TerminalBottomRibbon: () => null,
}));
vi.mock('@src/components/terminal/interactive-terminal/ColumnHeaderBar', () => ({ ColumnHeaderBar: () => null }));
vi.mock('@src/components/terminal/interactive-terminal/PaneBar', () => ({ PaneBar: () => null }));
vi.mock('@src/components/terminal/interactive-terminal/PaneSelectorBar', () => ({ PaneSelectorBar: () => null }));
vi.mock('@src/components/terminal/interactive-terminal/PaneView', () => ({ PaneView: () => null }));
vi.mock('@src/components/terminal/interactive-terminal/SidecarShellTerminal', () => ({
  SidecarShellTerminal: () => null,
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
vi.mock('@src/components/terminal/interactive-terminal/terminalConfig', () => ({
  FONT_FAMILY: 'monospace',
  FONT_SIZE_PX: 12,
  applyRtlGridContract: () => {},
  openTerminalLink: () => {},
  registerOsc52ClipboardWrite: () => {},
}));

// App-level hooks/contexts — resolved, empty environment.
const EMPTY_WINDOWS = vi.hoisted<string[]>(() => []);
vi.mock('@src/hooks/useContext', () => ({
  useContext: () => ({ agenticProcessTypeId: null, agenticProcess: null }),
}));
vi.mock('@src/hooks/entity-hooks', () => ({ useEntity: () => ({ data: null }) }));
vi.mock('@src/hooks/useShell', () => ({ useShell: () => ({ shell: null }) }));
vi.mock('@src/hooks/use-instance-preferences', () => ({ useInstancePreferences: () => ({ preferences: {} }) }));
vi.mock('@src/hooks/use-preference', () => {
  const tuples = new Map<string, [Record<string, never>, () => void]>();
  return {
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
vi.mock('@src/contexts/chat-ui-mode-context', () => ({
  useChatUiOverride: () => null,
  setChatUiOverride: () => {},
}));
vi.mock('@src/notifications/notify', () => ({
  notify: { error: () => {}, success: () => {}, info: () => {}, warning: () => {} },
}));
vi.mock('@src/components/image-annotator/annotate-files', () => ({
  annotateImageFiles: (files: File[]) => Promise.resolve(files),
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

beforeEach(() => {
  // Deterministic timers: the lifecycle defers fit (50ms) and dispose (10ms)
  // behind setTimeout; fake timers keep each test synchronous and stop one
  // test's deferred dispose from leaking into the next test's spy counts.
  vi.useFakeTimers();
  xtermSpies.open.calls = 0;
  xtermSpies.open.lastContainer = null;
  xtermSpies.dispose.calls = 0;
});
afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

// Transport flag flipped between renders — the mock process derives
// pty_mode/isHeadless from it, exactly like the entity after switchMode.
let headless = false;

const mockProcess = {
  id: '0b54c9f6-8f6e-4f0a-9a4e-2f0d64f7c111',
  typeId: null,
  status: ProcessStatus.RUNNING,
  busy: false,
  session_id: 'shell-sess-1',
  worker_type: 'codex',
  workdir: '/tmp/proj',
  project_id: null,
  plan_path: null,
  sidecar_shell_id: null,
  shell_id: null,
  markdown_docs: [],
  get pty_mode() {
    return !headless;
  },
  get isHeadless() {
    return headless;
  },
  getPlan: () => Promise.resolve(null),
  onPlan: () => () => {},
  on: () => {},
  off: () => {},
  watch: () => Promise.resolve(() => Promise.resolve()),
  loadHistory: () => Promise.resolve(),
} as unknown as AgenticProcess;

// className varies per render so React.memo's prop comparator (same sessionId,
// same process.id) doesn't swallow the re-render — in the app the equivalent
// re-render comes from the reactive entity update after switchMode.
const ui = (marker: string) => (
  <MemoryRouter>
    <InteractiveTerminal sessionId="shell-sess-1" active={false} process={mockProcess} className={marker} />
  </MemoryRouter>
);

describe('InteractiveTerminal — headless (pty_mode) round trip re-initializes xterm', () => {
  it('re-opens a terminal into the re-mounted container after chat → terminal', () => {
    headless = false;
    const { container, rerender } = render(ui('r1'));

    // Interactive leg: xterm opened into the rendered container.
    expect(xtermSpies.open.calls).toBe(1);
    const firstContainer = xtermSpies.open.lastContainer;
    expect(firstContainer).toBeTruthy();
    expect(container.contains(firstContainer)).toBe(true);
    expect(container.querySelector('[data-testid="simple-chat"]')).toBeNull();

    // terminal → chat: container unmounts, chat pane is the whole view.
    headless = true;
    rerender(ui('r2'));
    expect(container.querySelector('[data-testid="simple-chat"]')).toBeTruthy();
    expect(container.contains(firstContainer)).toBe(false);
    expect(xtermSpies.open.calls).toBe(1); // no phantom re-init while headless

    // chat → terminal: THE regression. A fresh container is mounted and the
    // init effect must run again — with `[sessionId]`-only deps it never did,
    // leaving both the xterm and the chat pane absent (blank window).
    headless = false;
    rerender(ui('r3'));
    expect(container.querySelector('[data-testid="simple-chat"]')).toBeNull();
    expect(xtermSpies.open.calls).toBe(2);
    expect(xtermSpies.open.lastContainer).not.toBe(firstContainer);
    expect(container.contains(xtermSpies.open.lastContainer)).toBe(true);
  });

  it('disposes the orphaned terminal when the transport goes headless', () => {
    headless = false;
    const { rerender } = render(ui('d1'));
    expect(xtermSpies.open.calls).toBe(1);

    // terminal → chat: the dep-array change makes the effect cleanup run NOW,
    // scheduling exactly one deferred dispose (setTimeout(…, 10)) for the
    // orphaned xterm instead of leaving it attached to the removed container.
    headless = true;
    rerender(ui('d2'));
    act(() => {
      vi.advanceTimersByTime(15);
    });
    expect(xtermSpies.dispose.calls).toBe(1);
  });
});
