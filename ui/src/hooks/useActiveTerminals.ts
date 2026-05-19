import {
  ActionInfo,
  AgenticProcess,
  dataContext,
  dataManager,
  Shell,
  ShellStatus,
  TypeId,
} from '@sdk';
import { subscribeToEntityOps } from '@sdk/react/hooks';
import { useCallback, useMemo, useSyncExternalStore } from 'react';

/** Discriminator for tab type. */
export type TerminalTabType = 'plain' | 'claude';

/**
 * One row in the tab strip.
 *
 * Strip contract:
 *   terminalState ← initial REST fetch ← `refresh()`
 *   terminalState ← direct mutations  ← `pushTerminal` / `removeTerminal` / `updateTerminal`
 *   terminalState ← debounced refetch ← Shell / AgenticProcess create+delete
 *                                       events on the WebSocket
 *
 * Cross-session sync: Shell and AgenticProcess WebSocket events (create,
 * update, delete) trigger a debounced re-fetch of `terminals/list`. This is
 * what surfaces external mutations (CLI, REST POST, another browser window,
 * backend bg tasks) in the open dock without a manual refresh. Update events
 * are included because AgenticProcess.visible toggles via an update op (the
 * backend filters APs by `visible=true` when building the strip) and Shell
 * status transitions can also affect strip membership. The 100ms debounce
 * keeps the refetch rate bounded under bursts.
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
let wsSubscribed = false;
let wsRefetchTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const cb of listeners) cb();
}

function setTerminalState(next: TerminalTab[]): void {
  if (next === terminalState) return;
  terminalState = next;
  notifyListeners();
}

/** Coalesce bursty WS events into one refetch (e.g. a loop of REST creates). */
function scheduleTerminalsRefetch(): void {
  if (wsRefetchTimer) return;
  wsRefetchTimer = setTimeout(() => {
    wsRefetchTimer = null;
    void fetchActiveTerminals();
  }, 100);
}

/** Subscribe (once, module-scoped) to Shell + AgenticProcess WebSocket events
 *  and refetch the strip when they fire. We listen to all three ops:
 *
 *  - create/delete: change strip identity directly.
 *  - update: can also change strip membership — most importantly,
 *    AgenticProcess.visible toggles via an update op (the backend's
 *    `terminals/list` only surfaces APs with `visible=true`, so the
 *    transition is invisible to a refetch unless update events trigger one).
 *    Shell status transitions (e.g. → CLOSING) also affect strip rendering.
 *
 *  The 100ms debounce in `scheduleTerminalsRefetch` keeps the rate bounded
 *  even under bursts of status flickers. The listener lives for the lifetime
 *  of the app — never unsubscribed — matching the same pattern as
 *  `pending-actions-store`. */
function ensureWsSubscription(): void {
  if (wsSubscribed) return;
  wsSubscribed = true;
  subscribeToEntityOps(
    [Shell.type, AgenticProcess.type],
    () => scheduleTerminalsRefetch(),
  );
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
  const action = new ActionInfo('terminals', 'compute_node', computeNodeId, 'GET');
  action.subpath = 'list';
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
  const incoming = fetched.sort(byTabOrder);
  setTerminalState(incoming);
  return incoming;
}

export interface TerminalCloseResponse {
  accepted: string[];
  missing: string[];
  invalid: string[];
}

export async function closeTerminalTargets(
  targets: Array<TerminalTab | TypeId | string>,
): Promise<TerminalCloseResponse> {
  const keys = targets.map(terminalTargetKey);
  const computeNodeId = dataContext.computeNode?.id;
  if (!computeNodeId || keys.length === 0) {
    return { accepted: [], missing: keys, invalid: [] };
  }
  const action = new ActionInfo('terminals', 'compute_node', computeNodeId, 'POST');
  action.subpath = 'close';
  action.bodyParameters = { targets: keys };
  const result = await dataManager.callAction<{ targets: string[] }, TerminalCloseResponse>(action);
  const accepted = result?.accepted ?? [];
  if (accepted.length > 0) {
    const closed = new Set(accepted);
    setTerminalState(terminalState.filter((tab) => !closed.has(terminalTargetKey(tab))));
  }
  return {
    accepted,
    missing: result?.missing ?? [],
    invalid: result?.invalid ?? [],
  };
}

function pushTerminalShared(tab: TerminalTab): void {
  const key = terminalTargetKey(tab);
  setTerminalState(
    terminalState.some((t) => terminalTargetKey(t) === key)
      ? terminalState.map((t) => (terminalTargetKey(t) === key ? tab : t))
      : [...terminalState, tab],
  );
}

function removeTerminalShared(target: TerminalTab | TypeId | string): void {
  const key = terminalTargetKey(target);
  setTerminalState(terminalState.filter((t) => terminalTargetKey(t) !== key));
}

function updateTerminalShared(target: TerminalTab | TypeId | string, patch: Partial<TerminalTab>): void {
  const key = terminalTargetKey(target);
  setTerminalState(terminalState.map((t) => (terminalTargetKey(t) === key ? { ...t, ...patch } : t)));
}

/**
 * Optimistically insert a row built from a freshly-loaded process + its shell.
 * Called by route loaders so the strip reflects a newly-active process *before*
 * the next terminals/list refetch completes — closes the race window in
 * which TabbedTerminal's self-heal effect would otherwise pick a stale tab.
 */
export function pushLoadedProcessTab(process: AgenticProcess, shell: Shell): void {
  const tab: TerminalTab = {
    targetTypeId: new TypeId(AgenticProcess.type, process.id),
    shellId: shell.id,
    processId: process.id,
    tabOrder: shell.tab_order ?? 0,
    name: process.name ?? shell.name ?? null,
    type: 'claude',
    isDisabled: shell.status === ShellStatus.CLOSING,
    statusReason: shell.status === ShellStatus.CLOSING ? 'Closing...' : '',
    projectId: process.project_id ?? shell.project_id ?? null,
    projectDisplayName: null,
    shell,
    agenticProcess: process,
  };
  pushTerminalShared(tab);
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
    ensureWsSubscription();
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
 * Project consolidation (Path A, 2026-05-09): every Shell carries a real
 * ``project_id`` (defaulting server-side to the bootstrap ``@local`` project
 * when none was passed). The historical orphan-include rule —
 * ``|| t.projectId == null`` — is gone; the strict per-project filter below
 * is now safe because no tab's ``projectId`` is ever null in normal flows.
 */
export function useProjectTerminals(projectId?: string | null): UseTerminalsResult {
  const all = useAllTerminals();
  const pid = projectId ?? dataContext.project?.id ?? null;
  const data = useMemo(
    () => (pid == null ? all.data : all.data.filter((t) => t.projectId === pid)),
    [all.data, pid],
  );
  return { ...all, data };
}
