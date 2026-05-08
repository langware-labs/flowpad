import {
  ActionInfo,
  AgenticProcess,
  dataContext,
  dataManager,
  Shell,
  ShellStatus,
  TypeId,
} from '@sdk';
import { useCallback, useMemo, useSyncExternalStore } from 'react';

/** Discriminator for tab type. */
export type TerminalTabType = 'plain' | 'claude';

/**
 * One row in the tab strip.
 *
 * Strip contract (deliberately simple):
 *   terminalState ← initial REST fetch ← `refresh()`
 *   terminalState ← direct mutations ← `pushTerminal` / `removeTerminal` / `updateTerminal`
 *
 * No WebSocket subscription, no merge ratchet, no implicit filtering. The list
 * the consumer renders is exactly what's in `terminalState`.
 *
 * Per-row liveness (status badges, names, restart-required) is read from the
 * dataManager entity cache via `Shell.getByIdFromCache` / `AgenticProcess.
 * getByIdFromCache`. Those caches are kept warm by the SDK's per-entity
 * subscriptions, independently of this hook.
 */
export interface TerminalTab {
  /** Canonical tab identity. Shell tabs use shell-<id>; process tabs use agentic_process-<id>. */
  targetTypeId: TypeId;
  /**
   * Current transport shell id. This is not the tab identity for process tabs:
   * AgenticProcess.start/open may replace process.shell_id while the process
   * tab remains the same targetTypeId.
   */
  shellId: string;
  processId: string | null;
  tabOrder: number;
  name: string | null;
  type: TerminalTabType;
  isDisabled: boolean;
  statusReason: string;
  projectId: string | null;
  projectDisplayName: string | null;
  /** Present when this row's shell is in cache. */
  shell?: Shell;
  /** Present when this row's process is in cache. */
  agenticProcess?: AgenticProcess;
}

interface WireShell {
  id: string;
  name?: string | null;
  tab_order?: number | null;
  status?: string | null;
  project_id?: string | null;
}

interface WireProcess {
  id: string;
  name?: string | null;
  shell_id?: string | null;
  project_id?: string | null;
  status?: string | null;
}

interface ActiveTerminalsResponse {
  pure_shells: WireShell[];
  visible_processes: WireProcess[];
  checked_at: string;
}

function shellFromCache(id: string): Shell | undefined {
  return (
    (Shell as unknown as { getByIdFromCache: (id: string) => Shell | null }).getByIdFromCache(id) ??
    undefined
  );
}

function processFromCache(id: string): AgenticProcess | undefined {
  return (
    (AgenticProcess as unknown as {
      getByIdFromCache: (id: string) => AgenticProcess | null;
    }).getByIdFromCache(id) ?? undefined
  );
}

function toShellTab(s: WireShell): TerminalTab {
  const cached = shellFromCache(s.id);
  const isClosing = s.status === ShellStatus.CLOSING;
  return {
    targetTypeId: new TypeId(Shell.type, s.id),
    shellId: s.id,
    processId: null,
    tabOrder: s.tab_order ?? cached?.tab_order ?? 0,
    name: s.name ?? cached?.name ?? null,
    type: 'plain',
    isDisabled: isClosing,
    statusReason: isClosing ? 'Closing...' : '',
    projectId: s.project_id ?? cached?.project_id ?? null,
    projectDisplayName: null,
    shell: cached,
  };
}

function toProcessTab(p: WireProcess): TerminalTab {
  const cached = processFromCache(p.id);
  const linkedShellId = p.shell_id ?? cached?.shell_id ?? '';
  const linkedShell = linkedShellId ? shellFromCache(linkedShellId) : undefined;
  const isClosing = linkedShell?.status === ShellStatus.CLOSING;
  return {
    targetTypeId: new TypeId(AgenticProcess.type, p.id),
    shellId: linkedShellId,
    processId: p.id,
    tabOrder: linkedShell?.tab_order ?? 0,
    name: p.name ?? linkedShell?.name ?? cached?.name ?? null,
    type: 'claude',
    isDisabled: isClosing,
    statusReason: isClosing ? 'Closing...' : '',
    projectId: p.project_id ?? cached?.project_id ?? linkedShell?.project_id ?? null,
    projectDisplayName: null,
    shell: linkedShell,
    agenticProcess: cached,
  };
}

function byTabOrder(a: TerminalTab, b: TerminalTab): number {
  if (a.tabOrder !== b.tabOrder) return a.tabOrder - b.tabOrder;
  // Stable secondary: plain shells before processes when tab_order is equal.
  if (a.type !== b.type) return a.type === 'plain' ? -1 : 1;
  return 0;
}

export function terminalTargetKey(tabOrTypeId: TerminalTab | TypeId | string): string {
  if (typeof tabOrTypeId === 'string') return tabOrTypeId;
  if (tabOrTypeId instanceof TypeId) return tabOrTypeId.toString();
  return tabOrTypeId.targetTypeId.toString();
}

export function terminalTransportShellId(tab: TerminalTab): string | null {
  if (tab.targetTypeId.type === Shell.type) return tab.targetTypeId.id;
  return tab.agenticProcess?.shell_id ?? tab.shellId ?? null;
}

export function terminalProcessId(tab: TerminalTab): string | null {
  return tab.targetTypeId.type === AgenticProcess.type ? tab.targetTypeId.id : null;
}

// ─── Module-level shared state ──────────────────────────────────────────────

let terminalState: TerminalTab[] = [];
let initialFetchStarted = false;
let activeTerminalsFetchVersion = 0;
const listeners = new Set<() => void>();
const closedTerminalKeys = new Set<string>();

function notifyListeners(): void {
  for (const cb of listeners) cb();
}

function setTerminalState(next: TerminalTab[]): void {
  if (next === terminalState) return;
  terminalState = next;
  notifyListeners();
}

/**
 * One-shot fetch + write-through. Replaces `terminalState` wholesale with the
 * server's view. Also feeds the dataManager cache via `castAndDeepAssign` so
 * per-row entity reads (`shell.status` etc.) stay live.
 *
 * Used by the hook for initial load and explicit refresh, and by route
 * loaders for default-tab resolution.
 */
export async function fetchActiveTerminals(): Promise<TerminalTab[]> {
  const computeNodeId = dataContext.computeNode?.id;
  if (!computeNodeId) return [];
  const fetchVersion = ++activeTerminalsFetchVersion;
  const action = new ActionInfo('active-terminals', 'compute_node', computeNodeId, 'GET');
  const result = await dataManager.callAction<unknown, ActiveTerminalsResponse>(action);
  if (!result) return [];
  // 1. Hydrate the entity cache so per-row reads (`shell.status`, `process.workerStatus`)
  //    stay live independently of this hook.
  for (const s of result.pure_shells) {
    try { dataManager.castAndDeepAssign(s); } catch { /* skip malformed */ }
  }
  for (const p of result.visible_processes) {
    try { dataManager.castAndDeepAssign(p); } catch { /* skip malformed */ }
  }
  // 2. Build the row list directly from both wire arrays — no join, no merge.
  //    Pure shells become plain rows; visible processes become AI-worker rows.
  const fetched: TerminalTab[] = [
    ...result.pure_shells.map(toShellTab),
    ...result.visible_processes.map(toProcessTab),
  ];
  if (fetchVersion !== activeTerminalsFetchVersion) return terminalState;

  const fetchedKeys = new Set(fetched.map(terminalTargetKey));
  for (const key of closedTerminalKeys) {
    if (!fetchedKeys.has(key)) closedTerminalKeys.delete(key);
  }

  const incoming = fetched.filter((tab) => !closedTerminalKeys.has(terminalTargetKey(tab))).sort(byTabOrder);
  setTerminalState(incoming);
  return incoming;
}

function pushTerminalShared(tab: TerminalTab): void {
  const key = terminalTargetKey(tab);
  closedTerminalKeys.delete(key);
  setTerminalState(
    terminalState.some((t) => terminalTargetKey(t) === key)
      ? terminalState.map((t) => (terminalTargetKey(t) === key ? tab : t))
      : [...terminalState, tab],
  );
}

function removeTerminalShared(target: TerminalTab | TypeId | string): void {
  const key = terminalTargetKey(target);
  closedTerminalKeys.add(key);
  setTerminalState(terminalState.filter((t) => terminalTargetKey(t) !== key));
}

function updateTerminalShared(target: TerminalTab | TypeId | string, patch: Partial<TerminalTab>): void {
  const key = terminalTargetKey(target);
  setTerminalState(terminalState.map((t) => (terminalTargetKey(t) === key ? { ...t, ...patch } : t)));
}

export interface UseTerminalsResult {
  data: TerminalTab[];
  /** Re-fetch from server and replace the list. Call after any action that
   *  may have changed the strip on the backend. */
  refresh: () => Promise<void>;
  /** Append (or replace if shellId exists). Call after the consumer creates
   *  a new tab so the strip reflects it without waiting on refresh. */
  pushTerminal: (tab: TerminalTab) => void;
  /** Drop a tab. Call after a user-initiated close. */
  removeTerminal: (target: TerminalTab | TypeId | string) => void;
  /** Patch a single tab in place. */
  updateTerminal: (target: TerminalTab | TypeId | string, patch: Partial<TerminalTab>) => void;
}

/**
 * Global tab list. One source, mutated by:
 *   - initial REST fetch (on first subscribe)
 *   - explicit ``refresh()``
 *   - direct mutators: ``pushTerminal`` / ``removeTerminal`` / ``updateTerminal``
 *
 * No filtering. Consumers that want a scoped view (e.g. per-project) should
 * use ``useProjectTerminals`` or filter ``data`` themselves.
 */
export function useAllTerminals(): UseTerminalsResult {
  const subscribe = useCallback((onChange: () => void) => {
    listeners.add(onChange);
    if (!initialFetchStarted) {
      initialFetchStarted = true;
      void fetchActiveTerminals();
    }
    return () => { listeners.delete(onChange); };
  }, []);
  const getSnapshot = useCallback(() => terminalState, []);
  const data = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    data,
    refresh: async () => { await fetchActiveTerminals(); },
    pushTerminal: pushTerminalShared,
    removeTerminal: removeTerminalShared,
    updateTerminal: updateTerminalShared,
  };
}

/**
 * Project-scoped derived view of ``useAllTerminals``. Same shared store and
 * mutators — only ``data`` is filtered. Pass an explicit ``projectId`` to
 * pin (e.g. for collaboration spaces); omit to default to the active project
 * via ``dataContext.project?.id``.
 *
 * Tabs whose `projectId` is null have no project affiliation (e.g. a plain
 * shell created before any project context is set) and are surfaced in every
 * scoped view — excluding them everywhere would orphan them from the UI.
 */
export function useProjectTerminals(projectId?: string | null): UseTerminalsResult {
  const all = useAllTerminals();
  const pid = projectId ?? dataContext.project?.id ?? null;
  const data = useMemo(
    () => (pid == null ? all.data : all.data.filter((t) => t.projectId === pid || t.projectId == null)),
    [all.data, pid],
  );
  return { ...all, data };
}
