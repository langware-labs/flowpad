import {
  ActionInfo,
  AgenticProcess,
  dataContext,
  dataManager,
  Shell,
} from '@sdk';
import { useCallback, useSyncExternalStore } from 'react';

/** Discriminator for tab type. */
export type TerminalTabType = 'plain' | 'claude';

/**
 * One row in the tab strip.
 *
 * Strip contract (deliberately simple):
 *   tabsState ← initial REST fetch ← `refresh()`
 *   tabsState ← direct mutations ← `pushTab` / `removeTab` / `updateTab`
 *
 * No WebSocket subscription, no merge ratchet, no implicit filtering. The list
 * the consumer renders is exactly what's in `tabsState`.
 *
 * Per-row liveness (status badges, names, restart-required) is read from the
 * dataManager entity cache via `Shell.getByIdFromCache` / `AgenticProcess.
 * getByIdFromCache`. Those caches are kept warm by the SDK's per-entity
 * subscriptions, independently of this hook.
 */
export interface TerminalTab {
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

interface WireTab {
  shell_id: string;
  process_id: string | null;
  tab_order: number;
  name: string | null;
  is_disabled: boolean;
  status_reason: string;
  project_id: string | null;
  project_display_name: string | null;
}

interface ActiveTerminalsResponse {
  shells: unknown[];
  processes: unknown[];
  tabs: WireTab[];
  checked_at: string;
}

function toTab(t: WireTab): TerminalTab {
  return {
    shellId: t.shell_id,
    processId: t.process_id,
    tabOrder: t.tab_order,
    name: t.name,
    type: t.process_id ? 'claude' : 'plain',
    isDisabled: t.is_disabled,
    statusReason: t.status_reason,
    projectId: t.project_id,
    projectDisplayName: t.project_display_name,
    shell: ((Shell as unknown as { getByIdFromCache: (id: string) => Shell | null }).getByIdFromCache(t.shell_id)) ?? undefined,
    agenticProcess: t.process_id
      ? ((AgenticProcess as unknown as { getByIdFromCache: (id: string) => AgenticProcess | null }).getByIdFromCache(t.process_id)) ?? undefined
      : undefined,
  };
}

// ─── Module-level shared state ──────────────────────────────────────────────

let tabsState: TerminalTab[] = [];
let initialFetchStarted = false;
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const cb of listeners) cb();
}

function setTabsState(next: TerminalTab[]): void {
  if (next === tabsState) return;
  tabsState = next;
  notifyListeners();
}

/**
 * One-shot fetch + write-through. Replaces `tabsState` wholesale with the
 * server's view. Also feeds the dataManager cache via `castAndDeepAssign` so
 * per-row entity reads (`shell.status` etc.) stay live.
 *
 * Used by the hook for initial load and explicit refresh, and by route
 * loaders for default-tab resolution.
 */
export async function fetchActiveTerminals(): Promise<TerminalTab[]> {
  const computeNodeId = dataContext.computeNode?.id;
  if (!computeNodeId) return [];
  const action = new ActionInfo('active-terminals', 'compute_node', computeNodeId, 'GET');
  const result = await dataManager.callAction<unknown, ActiveTerminalsResponse>(action);
  if (!result) return [];
  for (const s of result.shells) {
    try { dataManager.castAndDeepAssign(s); } catch { /* skip malformed */ }
  }
  for (const p of result.processes) {
    try { dataManager.castAndDeepAssign(p); } catch { /* skip malformed */ }
  }
  const incoming = result.tabs.map(toTab);
  setTabsState(incoming);
  return incoming;
}

function pushTabShared(tab: TerminalTab): void {
  setTabsState(
    tabsState.some((t) => t.shellId === tab.shellId)
      ? tabsState.map((t) => (t.shellId === tab.shellId ? tab : t))
      : [...tabsState, tab],
  );
}

function removeTabShared(shellId: string): void {
  setTabsState(tabsState.filter((t) => t.shellId !== shellId));
}

function updateTabShared(shellId: string, patch: Partial<TerminalTab>): void {
  setTabsState(tabsState.map((t) => (t.shellId === shellId ? { ...t, ...patch } : t)));
}

export interface UseActiveTerminalsResult {
  data: TerminalTab[];
  /** Re-fetch from server and replace the list. Call after any action that
   *  may have changed the strip on the backend. */
  refresh: () => Promise<void>;
  /** Append (or replace if shellId exists). Call after the consumer creates
   *  a new tab so the strip reflects it without waiting on refresh. */
  pushTab: (tab: TerminalTab) => void;
  /** Drop a tab. Call after a user-initiated close. */
  removeTab: (shellId: string) => void;
  /** Patch a single tab in place. */
  updateTab: (shellId: string, patch: Partial<TerminalTab>) => void;
}

export function useActiveTerminals(): UseActiveTerminalsResult {
  const subscribe = useCallback((onChange: () => void) => {
    listeners.add(onChange);
    if (!initialFetchStarted) {
      initialFetchStarted = true;
      void fetchActiveTerminals();
    }
    return () => { listeners.delete(onChange); };
  }, []);
  const getSnapshot = useCallback(() => tabsState, []);
  const data = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    data,
    refresh: async () => { await fetchActiveTerminals(); },
    pushTab: pushTabShared,
    removeTab: removeTabShared,
    updateTab: updateTabShared,
  };
}
