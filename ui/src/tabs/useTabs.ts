import {
  ActionInfo,
  AgenticProcess,
  dataContext,
  dataManager,
  DockPointerData,
  Project,
  Shell,
  ShellStatus,
  TypeId,
} from '@sdk';
import { subscribeToEntityOps } from '@sdk/react/hooks';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

/** Discriminator for tab type. */
export type TerminalTabType = 'plain' | 'claude';

/**
 * One row in the tab strip.
 *
 * Strip contract:
 *   terminalState ← initial REST fetch ← `refresh()`
 *   terminalState ← direct mutations  ← `pushTerminal` / `removeTerminal` / `updateTerminal`
 *   terminalState ← membership-only refetch ← Shell / AgenticProcess WS events
 *
 * Cross-session sync: WS events trigger a refetch of `tabs/list` ONLY
 * when they can change strip membership — create/delete on either entity,
 * and AgenticProcess update events where `tabbed` crossed the in-strip
 * boundary. Non-membership updates (Shell status/name/tab_order, AP name,
 * status, ready_for_input_since, etc.) do NOT refetch — per-row reads pull
 * live data from the dataManager entity cache, which the SDK keeps warm via
 * its own per-entity subscriptions.
 *
 * Order invariant: a refetch is non-destructive to current tab order.
 * Existing tabs keep their local index, refreshed in place; removed tabs
 * drop out; new tabs are appended at the end (sorted among themselves by
 * server `tab_order` for deterministic multi-add ordering). The server's
 * `tab_order` is only consulted on the FIRST fetch (when there is no local
 * order to preserve) and for ordering brand-new additions.
 *
 * Generalization direction (tab-management.md Part 3 §2): a tab is a
 * pointer-keyed descriptor; terminal tabs are the first kind. Entity-backed
 * kinds (markdown, skill, workflow, …) and transient kinds compose at the
 * strip-controller level on top of this store.
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

/** Unified `tabs/list` wire shape (tab-management.md Part 3 §4). */
interface TabsListResponse {
  tabs: Array<{ kind: string; entity: Record<string, unknown> }>;
  checked_at: string;
}

// ─── Entity-backed (non-terminal) tab rows ──────────────────────────────────

/**
 * Non-terminal kinds the store renders as entity member tabs (tab-management.md
 * Part 3 §3 "entity" column). Membership semantics differ from terminals:
 * close clears `tabbed` (the entity survives) instead of tearing anything down.
 */
export const ENTITY_TAB_KINDS = ['markdown', 'skill', 'workflow'] as const;

const ENTITY_TAB_KIND_SET = new Set<string>(ENTITY_TAB_KINDS);

/** Wire shape shared by all entity-backed tab rows (base-Entity fields). */
interface WireEntityRow {
  id: string;
  name?: string | null;
  project_id?: string | null;
  tab_order?: number | null;
  last_active_at?: number | null;
}

/** One entity-backed (non-terminal) tab row. */
export interface EntityTabRow {
  /** The wire `kind` — equals the entity type name (markdown/skill/workflow). */
  kind: string;
  typeId: TypeId;
  /** Canonical tab key: `typeId.toString()`. */
  key: string;
  name: string | null;
  projectId: string | null;
  tabOrder: number;
  /** epoch-ms recency stamp (server-side `activate`), null when never stamped. */
  lastActiveAt: number | null;
}

/** Wire → row mapping for entity-backed tabs (exported for unit tests). */
export function toEntityTabRow(kind: string, e: WireEntityRow): EntityTabRow {
  const lastActive = e.last_active_at;
  const typeId = new TypeId(kind, e.id);
  return {
    kind,
    typeId,
    key: typeId.toString(),
    name: e.name ?? null,
    projectId: e.project_id ?? null,
    tabOrder: e.tab_order ?? 0,
    lastActiveAt: typeof lastActive === 'number' ? lastActive : null,
  };
}

export function byEntityTabOrder(a: EntityTabRow, b: EntityTabRow): number {
  if (a.tabOrder !== b.tabOrder) return a.tabOrder - b.tabOrder;
  // Stable secondary: key, for deterministic multi-add ordering.
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
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

// `toShellTab`/`toProcessTab`/`byTabOrder`/`mergePreservingOrder` are exported for
// Phase-0 characterization tests (behaviour-neutral). The wire→tab mapping and the
// ordering/merge invariants are locked by `ui/tests/unit/tab-*.test.ts`.
export function toShellTab(s: WireShell): TerminalTab {
  const cached = shellFromCache(s.id);
  const isClosing = s.status === ShellStatus.CLOSING;
  return {
    targetTypeId: new TypeId(Shell.type, s.id),
    shellId: s.id,
    processId: null,
    tabOrder: s.tab_order ?? cached?.tab_order ?? 0,
    // Pure shells own their own name. AgenticProcess-backed tabs use toProcessTab.
    name: s.name ?? null,
    type: 'plain',
    isDisabled: isClosing,
    statusReason: isClosing ? 'Closing...' : '',
    projectId: s.project_id ?? cached?.project_id ?? null,
    projectDisplayName: null,
    shell: cached,
  };
}

export function toProcessTab(p: WireProcess): TerminalTab {
  const cached = processFromCache(p.id);
  const linkedShellId = p.shell_id ?? cached?.shell_id ?? '';
  const linkedShell = linkedShellId ? shellFromCache(linkedShellId) : undefined;
  const isClosing = linkedShell?.status === ShellStatus.CLOSING;
  return {
    targetTypeId: new TypeId(AgenticProcess.type, p.id),
    shellId: linkedShellId,
    processId: p.id,
    tabOrder: linkedShell?.tab_order ?? 0,
    // Source of truth: AgenticProcess.name. No fallback to shell — keeps the
    // canonical name on the process even after shell restart/deletion.
    name: p.name ?? null,
    type: 'claude',
    isDisabled: isClosing,
    statusReason: isClosing ? 'Closing...' : '',
    projectId: p.project_id ?? cached?.project_id ?? linkedShell?.project_id ?? null,
    projectDisplayName: null,
    shell: linkedShell,
    agenticProcess: cached,
  };
}

export function byTabOrder(a: TerminalTab, b: TerminalTab): number {
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

/**
 * The pointer terminal surfaces navigate to: the live PTY route. Prefers the
 * AgenticProcess's ``terminalDockPointer`` (its default ``dockPointer`` is the
 * read-only lens/transcript) over the plain shell pointer.
 */
export function terminalDockPointer(tab: TerminalTab): DockPointerData | null {
  return tab.agenticProcess?.terminalDockPointer ?? tab.shell?.dockPointer ?? null;
}

// ─── Module-level shared state ──────────────────────────────────────────────

let terminalState: TerminalTab[] = [];
let entityTabState: EntityTabRow[] = [];
let initialFetchStarted = false;
let firstFetchCompleted = false;
let inFlightFirstFetch: Promise<TerminalTab[]> | null = null;
let wsSubscribed = false;
let wsRefetchTimer: ReturnType<typeof setTimeout> | null = null;
let warnedUnknownKinds = false;
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const cb of listeners) cb();
}

function setTerminalState(next: TerminalTab[]): void {
  if (next === terminalState) return;
  terminalState = next;
  notifyListeners();
}

function setEntityTabState(next: EntityTabRow[]): void {
  if (next === entityTabState) return;
  entityTabState = next;
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
 *  and refetch the strip ONLY on membership-changing events:
 *
 *  - create / delete on either entity: row may appear or disappear.
 *  - AgenticProcess update where membership crossed the in-strip boundary:
 *    the AP just toggled into or out of the strip. Detected by comparing
 *    the current cached `tabbed` (authoritative; `visible` is its one-release
 *    deprecated alias, read as fallback — the SDK updates the entity cache
 *    BEFORE this listener fires, see use-entity-ops.ts) against whether the
 *    AP is currently in `terminalState`.
 *
 *  Everything else (Shell update of status/name/tab_order/project_id; AP
 *  update of name/status/ready_for_input_since/last_activity_at/...) is a
 *  pure rendering change. Per-row reads pull live data from the entity
 *  cache via `Shell.getByIdFromCache` / `AgenticProcess.getByIdFromCache`,
 *  so no refetch is needed for those — and a refetch would be actively
 *  harmful, since it costs a server round-trip and (before the
 *  non-destructive merge) could re-order tabs.
 *
 *  The 100ms debounce in `scheduleTerminalsRefetch` coalesces bursts. The
 *  listener lives for the lifetime of the app — never unsubscribed —
 *  matching the same pattern as `pending-actions-store`. */
function isApInStrip(apId: string): boolean {
  for (const t of terminalState) {
    if (t.processId === apId) return true;
  }
  return false;
}

function isEntityTabMember(key: string): boolean {
  for (const r of entityTabState) {
    if (r.key === key) return true;
  }
  return false;
}

function ensureWsSubscription(): void {
  if (wsSubscribed) return;
  wsSubscribed = true;
  subscribeToEntityOps(
    [Shell.type, AgenticProcess.type],
    (typeId, op, data) => {
      if (op === 'create' || op === 'delete') {
        scheduleTerminalsRefetch();
        return;
      }
      // op === 'update': only AP membership crossings change membership.
      if (typeId.type !== AgenticProcess.type) return;
      const payload = data as { tabbed?: boolean; visible?: boolean } | null;
      const p = processFromCache(typeId.id);
      const isMember = !!(payload?.tabbed ?? payload?.visible ?? p?.tabbed ?? p?.visible);
      if (isMember !== isApInStrip(typeId.id)) {
        scheduleTerminalsRefetch();
      }
    },
  );
  // Entity-backed kinds: same crossing pattern as APs — refetch membership
  // only when `tabbed` disagrees with the current strip membership, or on
  // create/delete. The OP PAYLOAD is read before the cache: membership
  // changes always ride a non-null `tabbed` on the wire (the exclude_none
  // rule), and a cross-client open of an entity this window has never cached
  // would otherwise be invisible (cache miss reads as non-member → no
  // crossing → the new tab never appears until reload).
  subscribeToEntityOps(
    [...ENTITY_TAB_KINDS],
    (typeId, op, data) => {
      // Unlike the terminal kinds above, create/delete is NOT unconditional
      // here: these kinds churn in bulk during indexer walks (every scanned
      // markdown/skill/workflow emits an op), and an unconditional refetch
      // per op would storm the strip with full tabs/list round-trips. Only
      // ops that can actually change membership refetch: a create that is
      // born `tabbed`, a delete of a current member, or an update crossing
      // the membership boundary.
      if (op === 'create') {
        const payload = data as { tabbed?: boolean } | null;
        if (payload?.tabbed) scheduleTerminalsRefetch();
        return;
      }
      if (op === 'delete') {
        if (isEntityTabMember(typeId.toString())) scheduleTerminalsRefetch();
        return;
      }
      const payload = data as { tabbed?: boolean } | null;
      const cached = dataManager.getByTypeIdFromCache(typeId) as { tabbed?: boolean } | null;
      const isMember = !!(payload?.tabbed ?? cached?.tabbed);
      if (isMember !== isEntityTabMember(typeId.toString())) {
        scheduleTerminalsRefetch();
      }
    },
  );
}

/**
 * Non-destructive merge of a freshly-fetched strip into the current one.
 *
 *   - First fetch (`firstFetchCompleted` false): adopt the server's sort order
 *     (`byTabOrder`). Any state already in `prev` (e.g. a route-loader
 *     optimistic pre-seed) is discarded so the strip starts from the server's
 *     canonical order. `prev.length === 0` is NOT a sufficient proxy — the
 *     loader can seed one tab before this runs, which trapped that tab at
 *     index 0 (the "selected tab becomes first after refresh" bug).
 *   - Existing tabs (key present in both): kept in their current local index,
 *     replaced in place with refreshed wire data (name, isDisabled, cached
 *     refs). Server `tab_order` is intentionally ignored — once a tab has a
 *     local position, only an explicit local reorder can move it.
 *   - Removed tabs (in prev, not in fetched): dropped.
 *   - New tabs (in fetched, not in prev): appended at the end, sorted among
 *     themselves by `byTabOrder` for deterministic multi-add ordering.
 *
 * Why end-append: any insertion in the middle of `prev` would perturb the
 * indices of existing tabs, which is the exact "tabs moving around" problem
 * this function exists to prevent.
 */
export function mergePreservingOrder<T = TerminalTab>(
  prev: T[],
  fetched: T[],
  firstFetchCompleted: boolean,
  // Generic over the row shape so entity-tab rows share the exact invariant;
  // the defaults keep every historical terminal call site unchanged.
  keyOf: (t: T) => string = terminalTargetKey as unknown as (t: T) => string,
  compare: (a: T, b: T) => number = byTabOrder as unknown as (a: T, b: T) => number,
): T[] {
  if (!firstFetchCompleted) return fetched.slice().sort(compare);
  const fetchedByKey = new Map<string, T>();
  for (const t of fetched) fetchedByKey.set(keyOf(t), t);
  const kept: T[] = [];
  const keptKeys = new Set<string>();
  for (const t of prev) {
    const key = keyOf(t);
    const refreshed = fetchedByKey.get(key);
    if (refreshed) {
      kept.push(refreshed);
      keptKeys.add(key);
    }
  }
  const additions: T[] = [];
  for (const t of fetched) {
    if (!keptKeys.has(keyOf(t))) additions.push(t);
  }
  if (additions.length > 1) additions.sort(compare);
  return kept.concat(additions);
}

/**
 * One-shot fetch + write-through. Merges the server's view into
 * `terminalState` non-destructively — see `mergePreservingOrder` for the
 * order invariant. Also feeds the dataManager cache via `castAndDeepAssign`
 * so per-row entity reads (`shell.status` etc.) stay live.
 *
 * Used by the hook for initial load and explicit refresh, and by route
 * loaders for default-tab resolution.
 */
export async function fetchActiveTerminals(): Promise<TerminalTab[]> {
  const computeNodeId = dataContext.computeNode?.id;
  if (!computeNodeId) return [];
  // Mark the first fetch as in-flight so the hook's subscribe gate
  // (`initialFetchStarted`) skips its own kickoff when a route loader is
  // already driving this call. We only flip `firstFetchCompleted` on success
  // so a network failure here doesn't lock the merge into preserve-order.
  initialFetchStarted = true;
  const action = new ActionInfo('tabs', 'compute_node', computeNodeId, 'GET');
  action.subpath = 'list';
  const result = await dataManager.callAction<unknown, TabsListResponse>(action);
  if (!result) return [];
  // 1. Hydrate the entity cache so per-row reads (`shell.status`, `process.workerStatus`)
  //    stay live independently of this hook.
  for (const row of result.tabs) {
    try { dataManager.castAndDeepAssign(row.entity); } catch { /* skip malformed */ }
  }
  // 2. Build the row lists directly from the unified wire rows — no join, no
  //    merge. `shell` rows become plain tabs; `agentic_process` rows become
  //    AI-worker tabs; entity kinds (markdown/skill/workflow) become
  //    `entityTabState` member rows. Unknown kinds (future entity onboarding,
  //    tab-management.md Part 3 §4) are skipped gracefully until the strip
  //    controller learns to render them.
  const unknownKinds = new Set<string>();
  const fetched: TerminalTab[] = [];
  const fetchedEntityRows: EntityTabRow[] = [];
  for (const row of result.tabs) {
    if (row.kind === 'shell') {
      fetched.push(toShellTab(row.entity as unknown as WireShell));
    } else if (row.kind === 'agentic_process') {
      fetched.push(toProcessTab(row.entity as unknown as WireProcess));
    } else if (ENTITY_TAB_KIND_SET.has(row.kind)) {
      fetchedEntityRows.push(toEntityTabRow(row.kind, row.entity as unknown as WireEntityRow));
    } else {
      unknownKinds.add(row.kind);
    }
  }
  if (unknownKinds.size > 0 && !warnedUnknownKinds) {
    warnedUnknownKinds = true;
    console.warn(
      `tabs/list returned tab kinds this client does not render yet (skipped): ${[...unknownKinds].join(', ')}`,
    );
  }
  const next = mergePreservingOrder(terminalState, fetched, firstFetchCompleted);
  // Entity rows share the same non-destructive order invariant (keyed by the
  // TypeId string, ordered by tab_order on first fetch / among additions).
  setEntityTabState(
    mergePreservingOrder(entityTabState, fetchedEntityRows, firstFetchCompleted, (r) => r.key, byEntityTabOrder),
  );
  setTerminalState(next);
  firstFetchCompleted = true;
  return next;
}

/**
 * Idempotent first-fetch. Loaders that need the strip populated before the
 * route renders should `await` this — concurrent callers share the same
 * in-flight request, and subsequent callers are no-ops returning the current
 * `terminalState`. Subsequent (post-first) refreshes should go through
 * `fetchActiveTerminals` directly.
 */
export async function ensureTerminalsFetched(): Promise<TerminalTab[]> {
  if (firstFetchCompleted) return terminalState;
  if (inFlightFirstFetch) return inFlightFirstFetch;
  inFlightFirstFetch = fetchActiveTerminals().finally(() => {
    inFlightFirstFetch = null;
  });
  return inFlightFirstFetch;
}

export interface TerminalCloseResponse {
  accepted: string[];
  missing: string[];
  invalid: string[];
}

/**
 * Batched `tabs/close` over any tab kind (terminal or entity member). ONE POST
 * per call — multi-close must never fan out (locked by
 * `terminal-close-all-race.test.ts`). The backend dispatches per-kind close
 * semantics (terminal teardown vs clear-membership); accepted targets are
 * optimistically removed from BOTH local lists.
 */
export async function closeTabTargets(
  targets: Array<TerminalTab | TypeId | string>,
): Promise<TerminalCloseResponse> {
  const keys = targets.map(terminalTargetKey);
  const computeNodeId = dataContext.computeNode?.id;
  if (!computeNodeId || keys.length === 0) {
    return { accepted: [], missing: keys, invalid: [] };
  }
  const action = new ActionInfo('tabs', 'compute_node', computeNodeId, 'POST');
  action.subpath = 'close';
  action.bodyParameters = { targets: keys };
  const result = await dataManager.callAction<{ targets: string[] }, TerminalCloseResponse>(action);
  const accepted = result?.accepted ?? [];
  if (accepted.length > 0) {
    const closed = new Set(accepted);
    setTerminalState(terminalState.filter((tab) => !closed.has(terminalTargetKey(tab))));
    setEntityTabState(entityTabState.filter((row) => !closed.has(row.key)));
  }
  return {
    accepted,
    missing: result?.missing ?? [],
    invalid: result?.invalid ?? [],
  };
}

/** Historical name — terminal call sites close through the same batched POST. */
export const closeTerminalTargets = closeTabTargets;

export interface TabsOpenResponse {
  accepted: string[];
  missing: string[];
  invalid: string[];
}

/**
 * Batched `tabs/open` (`tabbed=true`) — the ONLY promotion path from a
 * transient preview tab to a member tab (tab-management.md Part 3 §5).
 * Schedules a membership refetch so the new member row lands in the strip.
 */
export async function openTabTargets(
  targets: Array<TypeId | string>,
): Promise<TabsOpenResponse> {
  const keys = targets.map(terminalTargetKey);
  const computeNodeId = dataContext.computeNode?.id;
  if (!computeNodeId || keys.length === 0) {
    return { accepted: [], missing: keys, invalid: [] };
  }
  const action = new ActionInfo('tabs', 'compute_node', computeNodeId, 'POST');
  action.subpath = 'open';
  action.bodyParameters = { targets: keys };
  const result = await dataManager.callAction<{ targets: string[] }, TabsOpenResponse>(action);
  if ((result?.accepted?.length ?? 0) > 0) scheduleTerminalsRefetch();
  return {
    accepted: result?.accepted ?? [],
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

/** Shared `useSyncExternalStore` subscribe for every tabs-store hook: register
 *  the listener, ensure the module-scoped WS subscription, and kick off the
 *  first fetch exactly once. Module-level (stable identity) so each hook can
 *  pass it straight to `useSyncExternalStore`. */
function subscribeTabsStore(onChange: () => void): () => void {
  listeners.add(onChange);
  ensureWsSubscription();
  if (!initialFetchStarted) {
    initialFetchStarted = true;
    void fetchActiveTerminals();
  }
  return () => { listeners.delete(onChange); };
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
  const getSnapshot = useCallback(() => terminalState, []);
  const data = useSyncExternalStore(subscribeTabsStore, getSnapshot, getSnapshot);
  return {
    data,
    refresh: async () => { await fetchActiveTerminals(); },
    pushTerminal: pushTerminalShared,
    removeTerminal: removeTerminalShared,
    updateTerminal: updateTerminalShared,
  };
}

/**
 * Entity-backed (non-terminal) member tabs — markdown/skill/workflow rows from
 * the same `tabs/list` fetch, on the same module store + WS subscription as
 * the terminal rows. Returns the full list; consumers scope by `projectId`
 * (null = the global section, Part 3 §6).
 */
export function useEntityTabs(): EntityTabRow[] {
  const getSnapshot = useCallback(() => entityTabState, []);
  return useSyncExternalStore(subscribeTabsStore, getSnapshot, getSnapshot);
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

// ─── Project-bucketed view (chip consumes this) ─────────────────────────────

export type BucketState = 'loading' | 'live' | 'missing';

export interface TerminalProjectBucket {
  /** Stable bucket identity. For stranded buckets this is still the dangling
   *  Shell.project_id — the row exists, the Project entity just doesn't. */
  projectId: string;
  /** Resolved Project entity. Non-null iff ``state === 'live'``. */
  project: Project | null;
  /** 'loading' = cache miss, fetch in flight or pending; 'live' = entity
   *  resolved; 'missing' = backend confirmed 404 (stranded). */
  state: BucketState;
  tabs: TerminalTab[];
  /** Resurrect the Project from a tab's workdir + rebind every dependent's
   *  project_id (server-side, via compute_node/recover-orphaned-project).
   *  Resolves to the recovered Project, or null on failure. Only meaningful
   *  when ``state === 'missing'``. */
  recover: () => Promise<Project | null>;
}

export interface UseTerminalProjectBucketsResult {
  buckets: TerminalProjectBucket[];
}

function bucketProjectId(tab: TerminalTab): string | null {
  return tab.projectId ?? tab.shell?.project_id ?? tab.agenticProcess?.project_id ?? null;
}

/**
 * Bucket the global tab strip by ``project_id`` and resolve each bucket's
 * Project entity. Single owner of the "which projects own which tabs" question
 * — consumers (e.g. ProjectsCounterChip) render rows straight from this hook
 * without doing their own bucketing or dangling-FK fallback.
 *
 * Three bucket states:
 *   - ``loading``: cache miss, resolution in flight. Chip shows a placeholder.
 *   - ``live``: Project entity is in cache; bucket carries it.
 *   - ``missing``: backend returned 404 for the FK. Bucket exposes ``recover()``.
 *
 * Recovery is explicit — the hook does not auto-recover on mount (would re-enter
 * the auto-action antipattern called out in feedback memory).
 */
export function useTerminalProjectBuckets(): UseTerminalProjectBucketsResult {
  const { data: tabs } = useAllTerminals();

  const grouped = useMemo(() => {
    const byProject = new Map<string, TerminalTab[]>();
    for (const tab of tabs) {
      const pid = bucketProjectId(tab);
      if (!pid) continue;
      const bucket = byProject.get(pid);
      if (bucket) bucket.push(tab);
      else byProject.set(pid, [tab]);
    }
    return Array.from(byProject.entries());
  }, [tabs]);

  // Resolution status per project_id. Seeded from the cache so projects already
  // hydrated by other paths skip the loading flash.
  const [status, setStatus] = useState<ReadonlyMap<string, BucketState>>(() => new Map());

  useEffect(() => {
    const toCheck = grouped
      .map(([id]) => id)
      .filter((id) => {
        const known = status.get(id);
        if (known === 'live' || known === 'missing') return false;
        return true;
      });
    if (toCheck.length === 0) return;
    let cancelled = false;
    void (async () => {
      const results = await Promise.all(
        toCheck.map(async (id): Promise<[string, BucketState]> => {
          const cached = Project.getByIdFromCache<Project>(id);
          if (cached) return [id, 'live'];
          const fetched = await Project.getById<Project>(id).catch(() => null);
          return [id, fetched ? 'live' : 'missing'];
        }),
      );
      if (cancelled) return;
      setStatus((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const [id, s] of results) {
          if (next.get(id) !== s) {
            next.set(id, s);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [grouped, status]);

  const buckets = useMemo<TerminalProjectBucket[]>(() => {
    return grouped.map(([projectId, bucketTabs]) => {
      const cached = Project.getByIdFromCache<Project>(projectId) ?? null;
      const resolved = status.get(projectId);
      const state: BucketState = cached
        ? 'live'
        : resolved === 'missing'
          ? 'missing'
          : 'loading';
      const project = state === 'live' ? cached : null;
      const recover = async (): Promise<Project | null> => {
        if (project) return project;
        const computeNodeId = dataContext.computeNode?.id;
        if (!computeNodeId) return null;
        const recovered = await Project.recoverOrphaned(projectId, computeNodeId).catch(() => null);
        if (!recovered) return null;
        // Backend rebound dependents; clear the strand so the next render
        // reflects the live project. The WS Shell/AP update events will
        // re-fetch tabs/list and re-bucket under the recovered project_id.
        setStatus((prev) => {
          const next = new Map(prev);
          next.delete(projectId);
          next.set(recovered.id, 'live');
          return next;
        });
        return recovered;
      };
      return { projectId, project, state, tabs: bucketTabs, recover };
    });
  }, [grouped, status]);

  return { buckets };
}
