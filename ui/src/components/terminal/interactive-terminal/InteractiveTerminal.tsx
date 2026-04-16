// InteractiveTerminal.tsx
import '@src/styles/xterm.css';
import '@xterm/xterm/css/xterm.css';

import { dataContext, fsStore, isProcessLive, Shell, type AgenticProcess } from '@sdk';
import { PtySyncSession } from '@sdk/pty-sync/PtySyncSession.js';
import { useScrollSync } from '@sdk/pty-sync/ui/useScrollSync.js';
import { XTermHarness } from '@sdk/pty-sync/ui/XTermHarness.js';
import { useContext } from '@src/hooks/useContext';
import { useInputDir } from '@src/hooks/use-input-dir';
import { useSettings } from '@src/hooks/use-settings';
import { useDockNavigation } from '@src/navigation';
import { useAgenticQueue } from '@src/hooks/useAgenticQueue';
import { useFS } from '@src/hooks/useFS';
import { useShell } from '@src/hooks/useShell';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal as XTerm } from '@xterm/xterm';
import { useTheme } from 'next-themes';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { AnnotationGutter } from './AnnotationGutter';
import { ColumnHeaderBar } from './ColumnHeaderBar';
import { PaneBar } from './PaneBar';
import { PaneSelectorBar } from './PaneSelectorBar';
import { PaneView } from './PaneView';
import { ProcessToolbar } from './ProcessToolbar';
import { PtySyncProvider, usePtySyncSession } from './PtySyncContext';
import {
  GitPanel,
  InputFilesPanel,
  PromptIndexPanel,
  QueuePanel,
  SideTabId,
  SideWindow,
  type PromptEntry,
} from './side-windows';
import { SidecarShellTerminal } from './SidecarShellTerminal';
import { TerminalBottomRibbon } from './TerminalBottomRibbon';
import { TerminalSearchBar } from './TerminalSearchBar';
import { calcTimeGutterWidth, TimeGutter } from './TimeGutter';
import { TraceGutter } from './TraceGutter';
import { getAnchors, useAnnotationGutter } from './use-annotation-gutter';
import { useTimeGutter } from './use-time-gutter';
import { useTraceGutter } from './use-trace-gutter';

export interface TraceFilters {
  events: boolean;
  time: boolean;
  index: boolean;
  line: boolean;
  absLine: boolean;
  debugTime: boolean;
  refTime: boolean;
  promptAnnotations: boolean;
}

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
const LS_KEY = 'traceFilters';

export interface ColVisibility {
  trace: boolean;
  time: boolean;
  annotations: boolean;
}

const DEFAULT_COL_VIS: ColVisibility = { trace: true, time: true, annotations: true };
const COL_VIS_LS_KEY = 'colVisibility';

function loadColVis(): ColVisibility {
  try {
    return { ...DEFAULT_COL_VIS, ...JSON.parse(localStorage.getItem(COL_VIS_LS_KEY) ?? 'null') };
  } catch {
    return DEFAULT_COL_VIS;
  }
}

function saveColVis(v: ColVisibility): void {
  try {
    localStorage.setItem(COL_VIS_LS_KEY, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

function loadTraceFilters(): TraceFilters {
  try {
    return { ...DEFAULT_FILTERS, ...JSON.parse(localStorage.getItem(LS_KEY) ?? 'null') };
  } catch {
    return DEFAULT_FILTERS;
  }
}

function saveTraceFilters(f: TraceFilters): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(f));
  } catch {
    /* ignore */
  }
}

// Static terminal color themes (never change at runtime)
const DARK_THEME = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#ffffff',
  cursorAccent: '#1e1e1e',
  selectionBackground: 'rgba(255, 255, 255, 0.3)',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
};

const LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#1e1e1e',
  cursor: '#1e1e1e',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(0, 122, 204, 0.18)',
  black: '#000000',
  red: '#cd3131',
  green: '#00bc00',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#a5a5a5',
};

// ── Side-window state (tabs + active) managed atomically via reducer ─────────

type SideTabState = { tabs: SideTabId[]; active: SideTabId | null };
type SideTabAction =
  | { type: 'open'; tab: SideTabId } // add tab (if not present) and activate it
  | { type: 'close'; tab: SideTabId } // remove tab; activate previous or null
  | { type: 'select'; tab: SideTabId } // activate an already-open tab
  | { type: 'toggle'; tab: SideTabId }; // open+activate if closed; close if already active

function sideTabReducer(state: SideTabState, action: SideTabAction): SideTabState {
  switch (action.type) {
    case 'open': {
      const tabs = state.tabs.includes(action.tab) ? state.tabs : [...state.tabs, action.tab];
      return { tabs, active: action.tab };
    }
    case 'close': {
      const tabs = state.tabs.filter((t) => t !== action.tab);
      const active = state.active === action.tab ? (tabs[tabs.length - 1] ?? null) : state.active;
      return { tabs, active };
    }
    case 'select': {
      if (!state.tabs.includes(action.tab)) return state;
      return { ...state, active: action.tab };
    }
    case 'toggle': {
      if (state.active === action.tab && state.tabs.includes(action.tab)) {
        // Already the active tab — close it
        const tabs = state.tabs.filter((t) => t !== action.tab);
        return { tabs, active: tabs[tabs.length - 1] ?? null };
      }
      // Open (if not already present) and activate
      const tabs = state.tabs.includes(action.tab) ? state.tabs : [...state.tabs, action.tab];
      return { tabs, active: action.tab };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

interface InteractiveTerminalProps {
  sessionId: string;
  flow?: AgenticProcess | null;
  className?: string;
  active?: boolean;
  onTitleChange?: (title: string) => void;
  process?: AgenticProcess;
  /** Embedded mode: hides nav-out buttons (Open Terminal, Fork) in ProcessToolbar. */
  embedded?: boolean;
  /** Called by the close button shown in ProcessToolbar when embedded=true. */
  onClose?: () => void;
  /** Called whenever the worker session ID changes (or becomes null). */
  onWorkerSessionId?: (sessionId: string | null) => void;
}

/**
 * InteractiveTerminal - PTY-based interactive terminal component
 *
 * Note: flow prop is optional and only used for React.memo optimization
 * (prevents re-renders when flow object reference changes but ID is same).
 * Shell/PTY operations do NOT require flow - shell is infrastructure.
 */
const InteractiveTerminal: React.FC<InteractiveTerminalProps> = ({
  sessionId,
  flow: _flow = null,
  className = '',
  active = false,
  onTitleChange,
  process: propProcess,
  embedded,
  onClose,
  onWorkerSessionId,
}) => {
  // _flow is used only in the React.memo comparator below
  void _flow;

  const { agenticProcessTypeId, agenticProcess: contextProcess } = useContext();
  // Prop takes precedence (e.g. WorkflowsPage passes an explicit process).
  // For TabbedTerminal, no prop is passed — fall back to the context process
  // set by the loader, which is always authoritative for the active tab.
  const process = propProcess ?? contextProcess ?? undefined;
  const { navigation } = useDockNavigation();
  const { resolvedTheme } = useTheme();
  const [searchParams] = useSearchParams();
  const targetTimestamp = searchParams.get('t') ?? undefined;

  const canUseDOM = typeof window !== 'undefined' && typeof document !== 'undefined';

  const xtermContainerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);

  // pty-sync unified session (owns adapter, VT, segments)
  const ptySyncRef = useRef(new PtySyncSession());
  const harnessRef = useRef<XTermHarness | null>(null);
  // Reactive snapshot — subscribes to ptySyncRef without needing PtySyncProvider context
  const ptySyncSnapshot = usePtySyncSession(ptySyncRef.current);

  const shellRef = useRef<Shell | null>(null);

  const sessionIdRef = useRef(sessionId);

  const isTransitioningRef = useRef(false);
  const resizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [terminalReady, setTerminalReady] = useState(false);
  const [bufferFlushCount, setBufferFlushCount] = useState(0);
  const anchorsResolvedRef = useRef(false);

  const { settings } = useSettings();
  const { shell } = useShell(sessionId);
  const [shellReady, setShellReady] = useState(false);
  // Keep shellRef in sync so callbacks and hooks that capture shellRef still work.
  shellRef.current = shell;
  const processIsActive = isProcessLive(process?.status ?? '');

  // Notify parent when the worker session ID becomes known (or clears)
  useEffect(() => {
    onWorkerSessionId?.(process?.session_id ?? null);
  }, [process?.session_id, onWorkerSessionId]);
  const [cellHeight, setCellHeight] = useState(0);
  const [traceFilters, setTraceFiltersState] = useState<TraceFilters>(() => loadTraceFilters());
  const [gutterExpanded, setGutterExpanded] = useState(false);
  const [colVis, setColVisState] = useState<ColVisibility>(() => loadColVis());
  const [sideTabState, dispatchSideTab] = useReducer(sideTabReducer, { tabs: [], active: null });
  const sideWindowTabs = sideTabState.tabs;
  const activeSideTab = sideTabState.active;
  const [searchOpen, setSearchOpen] = useState(false);
  const [activePane, setActivePane] = useState<'claude' | 'shell'>('claude');
  const handlePasteRef = useRef<() => Promise<void>>(async () => {});

  const openSideTab = useCallback((tab: SideTabId) => {
    dispatchSideTab({ type: 'open', tab });
  }, []);

  const closeSideTab = useCallback((tab: SideTabId) => {
    dispatchSideTab({ type: 'close', tab });
  }, []);

  // Queue hook — idle injection of queued prompts
  const { queue, addEntry, removeEntry, setEnabled, moveEntry } = useAgenticQueue(
    process?.id,
    processIsActive,
    shellRef,
  );

  // Input dir info for file attachment workflow
  const inputDirInfo = useInputDir(process);
  const inputFs = useFS(inputDirInfo?.computeNodeTypeId ?? undefined);
  const inputFsRef = useRef(inputFs);
  inputFsRef.current = inputFs;
  const inputDirBrowse = inputDirInfo ? (inputFs?.browse(inputDirInfo.absPath) ?? null) : null;
  const fileCount = inputDirBrowse?.items.length ?? 0;

  const setTraceFilters = useCallback((f: TraceFilters) => {
    setTraceFiltersState(f);
    saveTraceFilters(f);
  }, []);

  const setColVis = useCallback((v: ColVisibility) => {
    setColVisState(v);
    saveColVis(v);
  }, []);

  // Sidecar shell state derived from entity
  const sidecarShellId = process?.sidecar_shell_id ?? null;

  const handleKillSidecar = useCallback(async () => {
    if (!process) return;
    process.sidecar_shell_id = null;
    await process.save();
    setActivePane('claude');
  }, [process]);

  const handleToggleSidecar = useCallback(async () => {
    if (!process) return;
    if (!sidecarShellId) {
      // Create a plain Shell entity and let SidecarShellTerminal start its PTY
      const computeNodeId = shellRef.current?.compute_node_id ?? dataContext.computeNode?.id ?? null;
      const computeNodeUname = shellRef.current?.compute_node_uname ?? dataContext.computeNode?.uname ?? null;
      if (!computeNodeId) return;
      const workdir = process.workdir ?? shellRef.current?.workdir ?? undefined;
      const shell = new Shell({
        compute_node_id: computeNodeId,
        compute_node_uname: computeNodeUname,
        workdir: workdir ?? null,
      });
      await shell.save();
      process.sidecar_shell_id = shell.id;
      await process.save();
      setActivePane('shell');
    } else {
      setActivePane((p) => (p === 'shell' ? 'claude' : 'shell'));
    }
  }, [process, sidecarShellId]);

  const handlePaneSelect = useCallback(
    (pane: 'claude' | 'shell') => {
      if (pane === 'claude') {
        void handleKillSidecar();
      } else {
        setActivePane('shell');
      }
    },
    [handleKillSidecar],
  );

  // Reset to claude pane when sidecar is killed externally
  useEffect(() => {
    if (!sidecarShellId) setActivePane('claude');
  }, [sidecarShellId]);

  // Fetch input dir listing whenever it becomes available (for file count badge).
  // Use inputFsRef to avoid re-firing on every render (useFS returns a new object each time).
  useEffect(() => {
    if (!inputDirInfo || !inputFsRef.current) return;
    void inputFsRef.current.listDirectory(inputDirInfo.absPath);
  }, [inputDirInfo?.absPath]);

  // Paste handler — updated whenever inputDirInfo changes
  useEffect(() => {
    handlePasteRef.current = async () => {
      if (!inputDirInfo) return;
      try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const imageType = item.types.find((t) => t.startsWith('image/'));
          if (imageType) {
            const blob = await item.getType(imageType);
            const ext = imageType.split('/')[1] ?? 'png';
            const filename = `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
            const file = new File([blob], filename, { type: imageType });
            const uploads = await fsStore
              .getState()
              .uploadFiles(inputDirInfo.computeNodeTypeId, inputDirInfo.absPath, [file]);
            await Promise.all(uploads.map((u) => u.waitForCompletion()));
            const fullPath = `${inputDirInfo.absPath}/${filename}`;
            await shellRef.current?.sendInput(`\nFile ${filename} is available here: ${fullPath}\n`);
            openSideTab(SideTabId.Files);
            return;
          }
        }
      } catch {
        // clipboard read failed — fall through to default xterm behavior
      }
    };
  }, [inputDirInfo, openSideTab]);

  // Scroll metrics from pty-sync library (firstVisibleRow, cellHeight, etc.)
  const metrics = useScrollSync(terminalRef.current, ptySyncSnapshot.adapter, []);
  const viewportY = metrics?.firstVisibleRow ?? 0;
  const metricsCellHeight = metrics?.cellHeight ?? cellHeight;
  const rows = metrics?.visibleRows ?? terminalRef.current?.rows ?? 24;

  const {
    entries: gutterEntries,
    totalTraceEvents,
    historicalCount,
    liveCount,
    sessionStartTime,
    allEvents: allTraceEvents,
  } = useTraceGutter(process?.session_id, terminalReady, ptySyncRef.current, shellReady, ptySyncSnapshot.version);
  const lastMessageTime = useMemo(() => {
    const last = allTraceEvents
      .filter((e) => e.source === 'transcript')
      .reduce<string | null>((max, e) => (max === null || e.timestamp > max ? e.timestamp : max), null);
    return last;
  }, [allTraceEvents]);

  const showGutter = !!process && traceFilters.events && colVis.trace;
  // Reserve gutter space based on user settings even before process resolves,
  // so xterm fits at the correct width from the start (avoids layout shift).
  const reserveGutterSpace = traceFilters.events && colVis.trace;
  const showTimeGutter =
    !!process &&
    colVis.time &&
    (traceFilters.time ||
      traceFilters.index ||
      traceFilters.line ||
      traceFilters.absLine ||
      traceFilters.debugTime ||
      traceFilters.refTime);
  const reserveTimeGutterSpace =
    colVis.time &&
    (traceFilters.time ||
      traceFilters.index ||
      traceFilters.line ||
      traceFilters.absLine ||
      traceFilters.debugTime ||
      traceFilters.refTime);
  const timeGutterWidth = showTimeGutter || reserveTimeGutterSpace ? calcTimeGutterWidth(traceFilters) : 0;

  const {
    elements: rawAnnotationElements,
    createBookmark,
    createComment,
    deleteBookmark,
    pendingScrollLine,
    sessionAnnotations,
  } = useAnnotationGutter(
    process?.session_id,
    terminalReady,
    ptySyncSnapshot.adapter,
    ptySyncRef.current,
    targetTimestamp,
    shellReady,
    ptySyncSnapshot.version,
    process?.workdir ?? undefined,
  );
  const annotationElements = useMemo(
    () =>
      traceFilters.promptAnnotations
        ? rawAnnotationElements
        : rawAnnotationElements.filter((el) => el.kind !== 'prompt'),
    [rawAnnotationElements, traceFilters.promptAnnotations],
  );
  const showAnnotationGutter = !!process?.session_id && colVis.annotations;
  const reserveAnnotationSpace = colVis.annotations;

  const lastPlanAnnotation = useMemo(() => {
    const plans = sessionAnnotations.filter((a) => a.labels?.includes('plan:'));
    if (plans.length === 0) return null;
    return plans.reduce((latest, a) =>
      String(a.created_date ?? '') > String(latest.created_date ?? '') ? a : latest,
    );
  }, [sessionAnnotations]);

  const handleOpenLastPlan = useCallback(() => {
    if (!lastPlanAnnotation || !agenticProcessTypeId) return;
    const filePath = (lastPlanAnnotation.data as Record<string, unknown>)?.file_path as string | undefined;
    if (filePath) navigation.openPlan(agenticProcessTypeId, filePath);
  }, [lastPlanAnnotation, agenticProcessTypeId, navigation]);

  const mergedPrompts = useMemo<PromptEntry[]>(() => {
    const annotationPrompts: PromptEntry[] = rawAnnotationElements
      .filter((el) => el.kind === 'prompt' && el.annotation)
      .map((el) => ({
        absRow: el.absRow ?? null,
        text: (el.annotation!.content as string) ?? '',
        time: (el.annotation!.created_date as unknown as string) ?? '',
        source: 'annotation' as const,
      }));

    const tracePrompts: PromptEntry[] = gutterEntries
      .filter((e) => e.event?.event_type === 'UserMessage')
      .map((e) => ({
        absRow: e.absRow ?? null,
        text: e.event.summary ?? '',
        time: e.event.timestamp ?? '',
        source: 'trace' as const,
      }))
      .filter((tp) => tp.text.trim() !== '' && !tp.text.startsWith('[Image: source:'));

    const annotationTexts = annotationPrompts.map((p) => p.text.trim().slice(0, 60).toLowerCase());
    const dedupedTrace = tracePrompts.filter((tp) => {
      const needle = tp.text.trim().slice(0, 60).toLowerCase();
      return !annotationTexts.some((at) => at.includes(needle) || needle.includes(at));
    });

    return [...annotationPrompts, ...dedupedTrace].sort((a, b) => a.time.localeCompare(b.time));
  }, [rawAnnotationElements, gutterEntries]);

  const timeGutterRows = useTimeGutter(ptySyncSnapshot.vt, viewportY, rows, ptySyncSnapshot.version);

  const scrollAnnotationToLine = useCallback((absoluteLine: number) => {
    ptySyncRef.current.getSnapshot().adapter?.scrollToRow(absoluteLine);
  }, []);

  const onAnnotationHoverRow = useCallback((absRow: number | null) => {
    const adapter = ptySyncRef.current.getSnapshot().adapter;
    if (!adapter) return;
    harnessRef.current?.setHoverHighlight(absRow, adapter.getEvictionOffset());
  }, []);

  // Scroll to annotation line when resolved by useAnnotationGutter.
  // Wait until the buffer actually contains the target row — during replay
  // the buffer grows progressively and the row may not exist yet.
  useEffect(() => {
    if (pendingScrollLine === null) return;
    const adapter = ptySyncRef.current.getSnapshot().adapter;
    if (!adapter) return;
    const maxRow = adapter.getEvictionOffset() + adapter.getBufferLength();
    if (pendingScrollLine <= maxRow) {
      scrollAnnotationToLine(pendingScrollLine);
    }
  }, [pendingScrollLine, scrollAnnotationToLine, bufferFlushCount]);

  // Rebuild anchor-based segments after replay is complete and annotations are loaded.
  // If no annotations, fall back to a default segment: [sessionStartTime → last transcript event].
  // bufferFlushCount is bumped by the output handler on each write until anchors resolve,
  // re-triggering this effect as content streams in (e.g. after page refresh).
  useEffect(() => {
    if (!terminalReady || !shellReady || !bufferFlushCount || !ptySyncSnapshot.adapter) return;
    const anchors = getAnchors(sessionAnnotations);
    if (anchors.length > 0) {
      ptySyncRef.current.buildSegmentsFromAnchors(anchors);
      anchorsResolvedRef.current = ptySyncRef.current.hasAnchorSegments();
    } else if (sessionStartTime) {
      const lastEventMs = allTraceEvents
        .filter((e) => e.source === 'transcript')
        .reduce((max, e) => Math.max(max, new Date(e.timestamp).getTime()), 0);
      if (lastEventMs > 0) {
        ptySyncRef.current.finalizeDefaultSegment(lastEventMs);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sessionAnnotations,
    terminalReady,
    shellReady,
    ptySyncSnapshot.adapter,
    sessionStartTime,
    allTraceEvents,
    bufferFlushCount,
  ]);

  // Refit terminal when annotation gutter or file panel appears/disappears
  useEffect(() => {
    if (!terminalReady) return;
    const fit = fitAddonRef.current;
    const term = terminalRef.current;
    if (!fit || !term) return;
    requestAnimationFrame(() => {
      try {
        fit.fit();
        const container = xtermContainerRef.current;
        if (container?.offsetHeight && term.rows > 0) {
          setCellHeight(container.offsetHeight / term.rows);
        }
      } catch {
        // ignore
      }
    });
  }, [showAnnotationGutter, showTimeGutter, timeGutterWidth, terminalReady, sideWindowTabs.length]);

  // Update refs on session change
  useEffect(() => {
    isTransitioningRef.current = true;

    if (resizeTimeoutRef.current) {
      clearTimeout(resizeTimeoutRef.current);
      resizeTimeoutRef.current = null;
    }

    sessionIdRef.current = sessionId;

    // Reset VT state on session switch
    ptySyncRef.current.resetSession();
    setBufferFlushCount(0);
    anchorsResolvedRef.current = false;

    const t = setTimeout(() => {
      isTransitioningRef.current = false;

      // After the transition guard lifts, re-fit the terminal so it picks up
      // any container resize events that were suppressed during the window.
      const fit = fitAddonRef.current;
      const term = terminalRef.current;
      if (fit && term) {
        requestAnimationFrame(() => {
          try {
            fit.fit();
            if (term.rows > 0 && xtermContainerRef.current?.offsetHeight) {
              setCellHeight(xtermContainerRef.current.offsetHeight / term.rows);
            }
            const shell = shellRef.current;
            if (shell?.connected) {
              void shell.resize(term.cols, term.rows);
            }
          } catch {
            /* ignore */
          }
        });
      }
    }, 150);

    return () => clearTimeout(t);
  }, [sessionId]);

  // Shell entity is resolved reactively by useShell(sessionId) above.

  // Recalibrate Phase-1 segment when the real session start time becomes known.
  // sessionStartTime comes from ClaudeSessionRecord.discover() via useTraceGutter
  // and reflects the original Claude session start — not the shell/replay creation time.
  useEffect(() => {
    if (!sessionStartTime || !ptySyncSnapshot.adapter) return;
    const startMs = new Date(sessionStartTime).getTime();
    const term = terminalRef.current;
    const rows = term ? Math.max(3, term.rows - 4) : 3;
    ptySyncRef.current.initSegments(startMs, rows, ptySyncSnapshot.adapter.getEvictionOffset());
  }, [sessionStartTime, ptySyncSnapshot.adapter]);

  /**
   * Terminal init/dispose
   */
  useLayoutEffect(() => {
    if (!canUseDOM || !xtermContainerRef.current) return;

    const container = xtermContainerRef.current;

    if (terminalRef.current) {
      return;
    }

    let disposed = false;
    let fitTimeoutId: ReturnType<typeof setTimeout> | null = null;
    let dimensionCheckTimeout: ReturnType<typeof setTimeout> | null = null;

    const waitForDimensions = () => {
      if (disposed) return;

      if (!container.offsetWidth || !container.offsetHeight) {
        dimensionCheckTimeout = setTimeout(waitForDimensions, 10);
        return;
      }

      initializeTerminal();
    };

    const initializeTerminal = () => {
      if (disposed) return;
      if (active) {
        const t0 = (window as Record<string, unknown>).__shellNavT0 as number | undefined;
        if (t0 !== undefined)
          console.log(`[PERF] +${(performance.now() - t0).toFixed(0)}ms xterm initializeTerminal (active)`);
      }

      const term = new XTerm({
        scrollback: 50000,
        convertEol: true,
        cursorBlink: true,
        scrollOnUserInput: true,
        disableStdin: false,
        cursorStyle: 'block',
        fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
        fontSize: 14,
        fontWeight: '400',
        fontWeightBold: '700',
        allowTransparency: true,
        allowProposedApi: true,
      });

      term.loadAddon(new WebLinksAddon());

      const fit = new FitAddon();
      term.loadAddon(fit);

      const search = new SearchAddon();
      term.loadAddon(search);
      searchAddonRef.current = search;

      term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
        if (event.type === 'keydown' && (event.ctrlKey || event.metaKey)) {
          if (event.key === 'c' && term.hasSelection()) {
            navigator.clipboard.writeText(term.getSelection()).catch(() => {});
            term.clearSelection();
            return false;
          }
          if (event.key === 'v') {
            void handlePasteRef.current();
            return false;
          }
        }
        return true;
      });

      try {
        term.open(container);
        terminalRef.current = term;
        fitAddonRef.current = fit;
        if (active) {
          const t0 = (window as Record<string, unknown>).__shellNavT0 as number | undefined;
          if (t0 !== undefined)
            console.log(`[PERF] +${(performance.now() - t0).toFixed(0)}ms term.open() done (active)`);
        }
      } catch (e) {
        console.error('[InteractiveTerminal] Failed to open terminal:', e);
        return;
      }

      term.options.theme = resolvedTheme === 'dark' ? DARK_THEME : LIGHT_THEME;

      try {
        term.parser.registerCsiHandler({ final: 'c', prefix: '?' }, () => true);
        term.parser.registerCsiHandler({ final: 'I' }, () => true);
        term.parser.registerCsiHandler({ final: 'O' }, () => true);
      } catch (e) {
        console.warn('[InteractiveTerminal] Parser API not available:', e);
      }

      term.onTitleChange((title: string) => {
        onTitleChange?.(title);
      });

      fitTimeoutId = setTimeout(() => {
        if (!disposed) {
          try {
            fit.fit();
            const h = container.offsetHeight;
            const r = term.rows;
            if (h && r > 0) setCellHeight(h / r);

            // Initialize pty-sync session (adapter + VirtualTerminal)
            ptySyncRef.current.initialize(term);
            const adapter = ptySyncRef.current.getSnapshot().adapter;
            if (adapter) harnessRef.current = new XTermHarness(term, adapter);

            // Init Phase-1 segment for trace event row bucketing.
            // startTime is set to now; recalibrated below once shell entity loads.
            ptySyncRef.current.initSegments(Date.now(), Math.max(3, term.rows - 4), adapter?.getEvictionOffset() ?? 0);

            if (active) {
              const t0 = (window as Record<string, unknown>).__shellNavT0 as number | undefined;
              if (t0 !== undefined)
                console.log(`[PERF] +${(performance.now() - t0).toFixed(0)}ms setTerminalReady(true) (active)`);
            }
            setTerminalReady(true);
            term.focus();

            requestAnimationFrame(() => {
              if (!disposed) {
                try {
                  fit.fit();
                } catch {
                  /* ignore */
                }
              }
            });
          } catch (e) {
            console.warn('[InteractiveTerminal] ❌ Failed to fit terminal on init:', e);
            setTerminalReady(true);
          }
        }
      }, 50);
    };

    waitForDimensions();

    return () => {
      disposed = true;

      if (dimensionCheckTimeout) {
        clearTimeout(dimensionCheckTimeout);
        dimensionCheckTimeout = null;
      }

      if (fitTimeoutId) {
        clearTimeout(fitTimeoutId);
        fitTimeoutId = null;
      }

      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
        resizeTimeoutRef.current = null;
      }

      setTerminalReady(false);

      if (terminalRef.current) {
        const term = terminalRef.current;
        setTimeout(() => {
          try {
            term.dispose();
          } catch (e) {
            console.warn('[InteractiveTerminal] Error disposing terminal:', e);
          }
        }, 10);

        terminalRef.current = null;
        fitAddonRef.current = null;
        searchAddonRef.current = null;
        ptySyncRef.current.dispose();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Intercept Cmd+F / Ctrl+F at the native DOM level so we can call preventDefault()
  // before the browser opens its own find bar. xterm's attachCustomKeyEventHandler
  // cannot do this — returning false there only suppresses xterm's processing,
  // not the browser's native behavior.
  useEffect(() => {
    const container = xtermContainerRef.current;
    if (!container) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (e.key === 'Escape') {
        setSearchOpen((open) => {
          if (open) {
            terminalRef.current?.focus();
            return false;
          }
          return open;
        });
      }
    };
    container.addEventListener('keydown', onKeyDown);
    return () => container.removeEventListener('keydown', onKeyDown);
  }, [terminalReady]);

  // Theme updates
  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;
    term.options.theme = resolvedTheme === 'dark' ? DARK_THEME : LIGHT_THEME;
  }, [resolvedTheme]);

  const handlePtyResize = useCallback(
    (cols: number, rows: number) => {
      if (isTransitioningRef.current) return;
      const shell = shellRef.current;
      if (!shell?.connected) return;

      try {
        void shell.resize(cols, rows);
      } catch (e) {
        console.error('[InteractiveTerminal] Failed to resize PTY:', e);
      }
    },
    [sessionId],
  );

  // PTY connect and WS reconnect are handled by process.start() (called in loader)
  // and Shell's built-in auto-reconnect (ConnectionManager on_reconnected listener).

  // Ref so the output handler always reads the latest bufferSyncUpdates without
  // requiring the effect to re-subscribe when the setting changes.
  const bufferSyncUpdatesRef = useRef(settings.bufferSyncUpdates);
  bufferSyncUpdatesRef.current = settings.bufferSyncUpdates;

  // Unified PTY lifecycle effect driven by Shell 'status' events.
  // On 'connected': reset xterm to a clean slate, write replay chunks,
  // subscribe live output. On 'disconnected': cleanup output subscription.
  // Gates on terminalReady so xterm is fitted to correct dimensions before
  // replay writes (otherwise writes at default 80x24).
  useEffect(() => {
    if (!shell || !terminalReady) return;

    const BSU = '\x1b[?2026h';
    const ESU = '\x1b[?2026l';
    let syncBuf = '';
    let inSync = false;
    let syncTimer: ReturnType<typeof setTimeout> | null = null;
    let unsubOutput: (() => void) | undefined;

    const writeToTerm = (data: string) => {
      const term = terminalRef.current;
      if (!term) return;
      try {
        term.write(data, () => {
          if (!anchorsResolvedRef.current) {
            ptySyncRef.current.notifyBufferReady();
            setBufferFlushCount((c) => c + 1);
          }
        });
      } catch (e) {
        console.error('[InteractiveTerminal] write failed:', e);
      }
    };

    const handlePtyData = (data: string, seq?: number) => {
      if (data.includes('\x1b[3J'))
        console.log('[PTY] ESC[3J (clear scrollback) received, seq:', seq, 'size:', data.length);
      if (data.includes('\x1b[2J')) console.log('[PTY] ESC[2J (clear screen) received, seq:', seq);
      if (data.includes('\x1b[H')) console.log('[PTY] ESC[H (cursor home) received, seq:', seq);
      if (seq !== undefined) {
        const chunk = shell.getPtyChunk(seq);
        if (chunk) ptySyncRef.current.processChunk(chunk);
      }

      if (!bufferSyncUpdatesRef.current) {
        writeToTerm(data);
        return;
      }

      console.log('############### applying buffering from BSU to ESU');
      if (!inSync) {
        const bsuIdx = data.indexOf(BSU);
        if (bsuIdx >= 0) {
          if (bsuIdx > 0) writeToTerm(data.slice(0, bsuIdx));
          inSync = true;
          syncBuf = data.slice(bsuIdx);
          syncTimer = setTimeout(() => {
            if (inSync && syncBuf) {
              writeToTerm(syncBuf);
              syncBuf = '';
              inSync = false;
            }
          }, 2000);
        } else {
          writeToTerm(data);
        }
      } else {
        syncBuf += data;
      }

      if (inSync) {
        const esuIdx = syncBuf.indexOf(ESU);
        if (esuIdx >= 0) {
          if (syncTimer) {
            clearTimeout(syncTimer);
            syncTimer = null;
          }
          const endIdx = esuIdx + ESU.length;
          const syncData = syncBuf.slice(0, endIdx);
          const remainder = syncBuf.slice(endIdx);
          syncBuf = '';
          inSync = false;
          writeToTerm(syncData);
          if (remainder) handlePtyData(remainder);
        }
      }
    };

    const onConnected = () => {
      const term = terminalRef.current;
      if (!term) return;

      // Reset xterm to a clean slate for this session.
      term.reset();

      // Replay buffered chunks from the SDK into xterm.
      const chunks = shell.getPtyChunks();
      for (const chunk of chunks) {
        ptySyncRef.current.processChunk(chunk);
        term.write(chunk.data);
      }

      // Signal buffer ready after xterm processes replay writes.
      if (chunks.length > 0) {
        term.write('', () => {
          anchorsResolvedRef.current = false;
          ptySyncRef.current.notifyBufferReady();
          setBufferFlushCount((c) => c + 1);
        });
      }

      // Send resize so the process redraws for current dimensions.
      if (shell.connected) void shell.resize(term.cols, term.rows);

      // Subscribe to live output (unsubscribe any prior subscription first).
      unsubOutput?.();
      unsubOutput = shell.onOutput(handlePtyData);

      setShellReady(true);
    };

    const onDisconnected = () => {
      unsubOutput?.();
      unsubOutput = undefined;
      setShellReady(false);
      if (syncTimer) {
        clearTimeout(syncTimer);
        syncTimer = null;
      }
      if (syncBuf && terminalRef.current) {
        try {
          terminalRef.current.write(syncBuf);
        } catch {}
        syncBuf = '';
        inSync = false;
      }
    };

    const unsubStatus = shell.on('status', (s: string) => {
      if (s === 'connected') onConnected();
      if (s === 'disconnected') onDisconnected();
    });

    // Fire immediately if already connected on mount (e.g. navigation to existing terminal).
    if (shell.connected) onConnected();

    return () => {
      unsubStatus();
      unsubOutput?.();

      if (syncTimer) clearTimeout(syncTimer);
      if (syncBuf && terminalRef.current) {
        try {
          terminalRef.current.write(syncBuf);
        } catch {}
        syncBuf = '';
        inSync = false;
      }
      setShellReady(false);
    };
  }, [shell, terminalReady]);

  // Input handler
  useEffect(() => {
    if (!sessionId || !terminalReady || !terminalRef.current) return;

    const term = terminalRef.current;
    const disp = term.onData(async (data: string) => {
      // eslint-disable-next-line no-control-regex
      if (/^\x1b\[\?[0-9;]*c$/.test(data)) return;
      const shell = shellRef.current;
      if (shell?.connected) await shell.sendInput(data);
    });

    return () => disp.dispose();
  }, [terminalReady, sessionId]);

  // On session restart: clear terminal, reset pty-sync, and re-fit so the
  // resumed session starts on a clean, full-size canvas.
  useEffect(() => {
    if (!process) return;

    const handleRestarted = () => {
      const term = terminalRef.current;
      const fit = fitAddonRef.current;
      ptySyncRef.current.resetSession();

      // connect({ force: true }) resets seq + replayDone, then re-attaches
      // and re-subscribes the output handler once replayDone flips true again.
      const shell = shellRef.current;
      void shell?.attachPty({ cols: term?.cols ?? 80, rows: term?.rows ?? 24, force: true });

      // Re-fit after a frame so xterm recalculates row/col geometry
      requestAnimationFrame(() => {
        if (fit && term) {
          try {
            fit.fit();
            const container = xtermContainerRef.current;
            if (container?.offsetHeight && term.rows > 0) {
              setCellHeight(container.offsetHeight / term.rows);
            }
            // Send updated dimensions to the new PTY
            const shell = shellRef.current;
            if (shell?.connected) {
              void shell.resize(term.cols, term.rows);
            }
          } catch {
            /* ignore */
          }
        }
      });
    };

    process.on('restarted', handleRestarted);
    return () => {
      process.off('restarted', handleRestarted);
    };
  }, [process]);

  // ResizeObserver (only when active)
  useEffect(() => {
    if (!canUseDOM) return;
    if (!xtermContainerRef.current) return;

    const container = xtermContainerRef.current;

    const observer = new ResizeObserver(() => {
      if (!active) return;
      if (isTransitioningRef.current) return;

      const term = terminalRef.current;
      const fit = fitAddonRef.current;
      if (!term || !fit) return;

      try {
        fit.fit();
      } catch {
        return;
      }

      if (container.offsetHeight && term.rows > 0) {
        setCellHeight(container.offsetHeight / term.rows);
      }

      // Rebuild VirtualTerminal with new dimensions and replay stored chunks
      const snapshot = ptySyncRef.current.getSnapshot();
      if (snapshot.adapter && snapshot.vt) {
        const shell = shellRef.current;
        if (shell) {
          ptySyncRef.current.rebuild(shell.getPtyChunks());
        }
      }

      if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
      resizeTimeoutRef.current = setTimeout(() => {
        const t = terminalRef.current;
        if (!t) return;
        if (!active) return;
        if (isTransitioningRef.current) return;
        handlePtyResize(t.cols, t.rows);
        resizeTimeoutRef.current = null;
      }, 250);
    });

    observer.observe(container);
    return () => {
      observer.disconnect();
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
        resizeTimeoutRef.current = null;
      }
    };
  }, [active, handlePtyResize, sessionId, canUseDOM, terminalReady]);

  // Active tab focus/refresh — skip scrollToBottom when navigating to a bookmark
  // so the bookmark scroll (pendingScrollLine) can land without being overridden.
  useEffect(() => {
    if (!active) return;
    if (!terminalReady) return;

    const term = terminalRef.current;
    const fit = fitAddonRef.current;
    if (!term || !fit) return;

    requestAnimationFrame(() => {
      try {
        fit.fit();
        if (!targetTimestamp) term.scrollToBottom();
        term.refresh(0, Math.max(0, term.rows - 1));
        term.focus();
        handlePtyResize(term.cols, term.rows);
      } catch (e) {
        console.warn('[InteractiveTerminal] activate refresh failed:', e);
      }
    });
  }, [active, terminalReady, sessionId, handlePtyResize, targetTimestamp]);

  const handleContainerClick = () => {
    terminalRef.current?.focus();
  };

  const handleFileDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      if (!inputDirInfo) return;
      const files = Array.from(e.dataTransfer.files);
      if (!files.length) return;
      const uploads = await fsStore.getState().uploadFiles(inputDirInfo.computeNodeTypeId, inputDirInfo.absPath, files);
      await Promise.all(uploads.map((u) => u.waitForCompletion()));
      for (const file of files) {
        const fullPath = `${inputDirInfo.absPath}/${file.name}`;
        await shellRef.current?.sendInput(`\nFile ${file.name} is available here: ${fullPath}\n`);
      }
      openSideTab(SideTabId.Files);
    },
    [inputDirInfo, openSideTab],
  );

  // Compute synthetic shell-pane active state for the ribbon
  const ribbonOpenTabs = sidecarShellId ? [...sideWindowTabs, SideTabId.Shell] : sideWindowTabs;
  const ribbonActiveSideTab = activePane === 'shell' && sidecarShellId ? SideTabId.Shell : activeSideTab;

  return (
    <div className={`relative flex h-full flex-col ${className}`} onDragOver={(e) => e.preventDefault()}>
      {/* Top bar — ProcessToolbar (Claude pane) or PaneBar (Shell pane) */}
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

      <PtySyncProvider session={ptySyncRef.current}>
        {/* Column header — only for Claude pane */}
        {process && activePane === 'claude' ? (
          <ColumnHeaderBar
            showTrace={showGutter}
            traceWidth={48}
            totalTraceEvents={totalTraceEvents}
            historicalCount={historicalCount}
            liveCount={liveCount}
            showTime={showTimeGutter}
            timeWidth={timeGutterWidth}
            traceFilters={traceFilters}
            showAnnotations={showAnnotationGutter}
            annotationsWidth={24}
            annotationElements={annotationElements}
            onToggleTrace={() => setColVis({ ...colVis, trace: !colVis.trace })}
            onHideTime={() => setColVis({ ...colVis, time: false })}
            onToggleAnnotations={() => setColVis({ ...colVis, annotations: !colVis.annotations })}
          />
        ) : null}

        <div className="flex min-h-0 flex-1">
          {/* Left pane selector strip — only when sidecar exists */}
          {sidecarShellId && <PaneSelectorBar activePane={activePane} onSelect={handlePaneSelect} />}

          {/* Claude pane — kept mounted, hidden when shell is active (preserves xterm) */}
          <div
            className="relative flex min-h-0 flex-1 flex-row"
            style={{ display: activePane !== 'claude' ? 'none' : undefined }}
          >
            {/* Relative container: xterm fills the space with padding for gutters;
                gutters are absolutely positioned over the padded areas.
                This prevents any gutter mount/unmount from changing xterm width. */}
            <div className="relative min-h-0 flex-1">
              {/* Wrapper reserves gutter space; xterm fills the content area only */}
              <div
                className="absolute inset-0 flex"
                style={{
                  paddingLeft:
                    (showGutter || reserveGutterSpace ? 48 : 0) +
                    (showTimeGutter || reserveTimeGutterSpace ? timeGutterWidth : 0),
                  paddingRight: showAnnotationGutter || reserveAnnotationSpace ? 24 : 0,
                }}
              >
                <div
                  ref={xtermContainerRef}
                  className="relative min-h-0 min-w-0 flex-1"
                  onClick={handleContainerClick}
                  tabIndex={0}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    void handleFileDrop(e);
                  }}
                >
                  {searchOpen && (
                    <div onClick={(e) => e.stopPropagation()}>
                      <TerminalSearchBar
                        searchAddon={searchAddonRef.current}
                        onClose={() => {
                          setSearchOpen(false);
                          terminalRef.current?.focus();
                        }}
                      />
                    </div>
                  )}
                </div>
              </div>
              {/* Gutters — absolutely positioned over padded areas */}
              {showGutter && (
                <div className="absolute bottom-0 left-0 top-0" style={{ width: 48, zIndex: gutterExpanded ? 50 : 1 }}>
                  <TraceGutter
                    entries={gutterEntries}
                    totalTraceEvents={totalTraceEvents}
                    historicalCount={historicalCount}
                    liveCount={liveCount}
                    viewportY={viewportY}
                    rows={rows}
                    cellHeight={metricsCellHeight}
                    projectEncodedName={dataContext.project?.fs_storage_mount_path?.replace(/\//g, '-')}
                    expanded={gutterExpanded}
                    onOpen={() => setGutterExpanded(true)}
                    onClose={() => setGutterExpanded(false)}
                    hideCounter
                  />
                </div>
              )}
              {showTimeGutter && (
                <div className="absolute bottom-0 top-0" style={{ left: 48, width: timeGutterWidth, zIndex: 1 }}>
                  <TimeGutter
                    rows={timeGutterRows}
                    cellHeight={metricsCellHeight}
                    filters={traceFilters}
                    ptySyncSession={ptySyncRef.current}
                    viewportY={viewportY}
                    refLines={ptySyncSnapshot.refLines}
                  />
                </div>
              )}
              {showAnnotationGutter && (
                <div className="absolute bottom-0 right-0 top-0" style={{ width: 24, zIndex: 1 }}>
                  <AnnotationGutter
                    elements={annotationElements}
                    viewportY={viewportY}
                    rows={rows}
                    cellHeight={metricsCellHeight}
                    scrollToLine={scrollAnnotationToLine}
                    createBookmark={createBookmark}
                    createComment={createComment}
                    deleteBookmark={deleteBookmark}
                    onHoverRow={onAnnotationHoverRow}
                    hideCounter
                  />
                </div>
              )}
            </div>

            {/* Side window (non-Shell tabs) */}
            {sideWindowTabs.length > 0 && activeSideTab && (
              <SideWindow
                tabs={sideWindowTabs}
                activeTab={activeSideTab}
                onSelect={(tab) => dispatchSideTab({ type: 'select', tab })}
                onClose={closeSideTab}
              >
                {activeSideTab === SideTabId.Git && (
                  <GitPanel
                    computeNodeId={shellRef.current?.compute_node_id ?? dataContext.computeNode?.id ?? ''}
                    workdir={shellRef.current?.workdir ?? process?.workdir ?? ''}
                    sidecarShellId={sidecarShellId}
                  />
                )}
                {activeSideTab === SideTabId.Prompts && (
                  <PromptIndexPanel prompts={mergedPrompts} onScrollToLine={scrollAnnotationToLine} />
                )}
                {activeSideTab === SideTabId.Queue && process && (
                  <QueuePanel
                    queue={queue}
                    onAdd={(e) => {
                      void addEntry(e);
                    }}
                    onRemove={(i) => {
                      void removeEntry(i);
                    }}
                    onMove={(i, d) => {
                      void moveEntry(i, d);
                    }}
                    onSetEnabled={(v) => {
                      void setEnabled(v);
                    }}
                  />
                )}
                {activeSideTab === SideTabId.Files && inputDirInfo && (
                  <InputFilesPanel
                    computeNodeTypeId={inputDirInfo.computeNodeTypeId}
                    inputDirAbsPath={inputDirInfo.absPath}
                  />
                )}
              </SideWindow>
            )}
          </div>

          {/* Shell pane — full content area when active */}
          {activePane === 'shell' && sidecarShellId && (
            <PaneView>
              <SidecarShellTerminal shellId={sidecarShellId} active={true} className="min-h-0 flex-1" />
            </PaneView>
          )}
        </div>
      </PtySyncProvider>

      {process && (
        <TerminalBottomRibbon
          fileCount={fileCount}
          isActive={processIsActive}
          promptCount={mergedPrompts.length}
          queue={queue}
          onQueueAdd={(e) => {
            void addEntry(e);
          }}
          onQueueRemove={(i) => {
            void removeEntry(i);
          }}
          openTabs={ribbonOpenTabs}
          activeSideTab={ribbonActiveSideTab}
          onOpenSideTab={(tab) => {
            if (tab === SideTabId.Shell) {
              void handleToggleSidecar();
            } else {
              dispatchSideTab({ type: 'toggle', tab });
            }
          }}
          hasLastPlan={!!lastPlanAnnotation}
          onOpenLastPlan={handleOpenLastPlan}
        />
      )}
    </div>
  );
};

// Memoize to prevent unnecessary remounts when parent re-renders
export default React.memo(InteractiveTerminal, (prevProps, nextProps) => {
  const processIdSame = prevProps.flow?.typeId === nextProps.flow?.typeId;

  return (
    prevProps.sessionId === nextProps.sessionId &&
    processIdSame &&
    prevProps.className === nextProps.className &&
    prevProps.active === nextProps.active &&
    prevProps.process?.id === nextProps.process?.id
  );
});
