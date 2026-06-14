import {
  ActionInfo,
  AgenticProcess,
  dataContext,
  dataManager,
  DockPointerData,
  Project,
  QueryFilter,
  QueryRequest,
  Shell,
  ShellStatus,
  Tab,
  TypeId,
  ViewType,
} from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useEffect, useMemo, useState } from 'react';

/** Discriminator for tab type. */
export type TerminalTabType = 'plain' | 'claude';

/**
 * One terminal row in the tab strip. Built by `useTerminalTabs` from a
 * terminal-target `Tab` entity (membership + `tab_order` + recency) joined to
 * its live `Shell`/`AgenticProcess` (status/PTY/name). See docs/tab-management.md.
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
  /** Recency seed for resolveActive, sourced from the backing `Tab` row
   *  (epoch-ms; null when never activated). Falls back to the entity. */
  lastActiveAt?: number | string | null;
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
 * read-only lens/transcript) over the plain shell pointer. Falls back to a
 * pointer built from the tab's canonical targetTypeId (shell-<id> /
 * agentic_process-<id> — which IS the shell-route pointer segment) so an
 * unhydrated tab still navigates instead of silently no-opping.
 */
export function terminalDockPointer(tab: TerminalTab): DockPointerData {
  return (
    tab.agenticProcess?.terminalDockPointer ??
    tab.shell?.dockPointer ??
    new DockPointerData(ViewType.SHELL, tab.targetTypeId.toString())
  );
}

// ─── Tab-sourced terminal rows (docs/tab-management.md) ─────────────────────
// Terminal tabs are driven by the `Tab` entity: the route loader materializes a
// Tab for every opened shell / agentic_process; this hook reads the visible
// Tabs, keeps the terminal-target rows, resolves each to its live entity, and
// builds the same `TerminalTab` the controller renders. Membership = a Tab
// exists; the old `compute_node` `tabs/list` + base-Entity `tabbed` are gone.

const TERMINAL_TARGET_TYPES = new Set<string>([Shell.type, AgenticProcess.type]);
const DEAD_SHELL_STATES = new Set<string>([ShellStatus.CLOSING, ShellStatus.CLOSED, ShellStatus.ERROR]);

// Shared query identities (useEntitiesQuery keys by query content, so the strip
// and this hook share one subscription). The Shell/AgenticProcess queries
// hydrate the entity cache and make status/name changes reactive.
const VISIBLE_TABS_QUERY = new QueryRequest({
  type: Tab.type,
  scope: [],
  name: 'tabs:visible',
  query: new QueryFilter({ match: { visible: true } }),
});
const ALL_SHELLS_QUERY = new QueryRequest({ type: Shell.type, scope: [], name: 'tabs:shells' });
const ALL_PROCESSES_QUERY = new QueryRequest({ type: AgenticProcess.type, scope: [], name: 'tabs:processes' });

/** Sets of currently-existing terminal entity ids; `null` = "not loaded yet"
 *  (don't apply the existence filter, to avoid a cold-load flicker). */
interface KnownTerminalIds {
  shells: Set<string> | null;
  processes: Set<string> | null;
}

/** A terminal-target Tab row → TerminalTab, or null when filtered out
 *  (target deleted, background-owned shell, dead shell). */
function terminalTabFromTab(tab: Tab, known: KnownTerminalIds): TerminalTab | null {
  const targetId = tab.target_id ?? '';
  if (!targetId) return null;
  // tab_order/recency come from the Tab row; everything else from the builder.
  const withTabFields = (base: TerminalTab): TerminalTab => ({
    ...base,
    tabOrder: tab.tab_order ?? base.tabOrder,
    lastActiveAt: tab.last_active_at,
  });
  if (tab.target_type === Shell.type) {
    // The target entity is gone (closed/deleted): drop the ghost row instead of
    // rendering its raw id. Complements the server-side orphan-Tab cleanup.
    if (known.shells && !known.shells.has(targetId)) return null;
    const cached = shellFromCache(targetId);
    // Background shells (owned by an AgenticProcess) are represented by the
    // process row, never their own — mirrors the backend reverse-owned rule.
    if (cached?.agentic_process_id) return null;
    // Dead shells drop out of the strip (status-derived, reactive).
    if (cached && DEAD_SHELL_STATES.has(cached.status)) return null;
    // Live shell name wins (terminals auto-rename via PTY title); the Tab's
    // create-time name is only a fallback before the entity is cached.
    return withTabFields(
      toShellTab({
        id: targetId,
        name: cached?.name ?? tab.name ?? null,
        tab_order: tab.tab_order,
        status: cached?.status,
        project_id: tab.project_id ?? cached?.project_id ?? null,
      }),
    );
  }
  if (tab.target_type === AgenticProcess.type) {
    if (known.processes && !known.processes.has(targetId)) return null;
    const cached = processFromCache(targetId);
    return withTabFields(
      toProcessTab({
        id: targetId,
        name: cached?.name ?? tab.name ?? null,
        project_id: tab.project_id ?? cached?.project_id ?? null,
      }),
    );
  }
  return null;
}

function buildTerminalRows(tabs: Tab[], projectId: string | null, known: KnownTerminalIds): TerminalTab[] {
  const rows: TerminalTab[] = [];
  for (const t of tabs) {
    if (!TERMINAL_TARGET_TYPES.has(t.target_type ?? '')) continue;
    const row = terminalTabFromTab(t, known);
    if (row) rows.push(row);
  }
  const scoped = projectId == null ? rows : rows.filter((r) => r.projectId === projectId);
  return scoped.sort(byTabOrder);
}

function knownIds(shells: Shell[] | undefined, processes: AgenticProcess[] | undefined): KnownTerminalIds {
  return {
    shells: shells ? new Set(shells.map((s) => s.id)) : null,
    processes: processes ? new Set(processes.map((p) => p.id)) : null,
  };
}

/**
 * Terminal strip rows, sourced from the `Tab` entity. Replaces
 * `useProjectTerminals`. `tab_order`/`last_active_at` come from the Tab (durable
 * per-client order — no `mergePreservingOrder` needed).
 */
export function useTerminalTabs(projectId?: string | null): TerminalTab[] {
  const { data: tabs } = useEntitiesQuery<Tab>(VISIBLE_TABS_QUERY);
  const { data: shells } = useEntitiesQuery<Shell>(ALL_SHELLS_QUERY);
  const { data: processes } = useEntitiesQuery<AgenticProcess>(ALL_PROCESSES_QUERY);
  const pid = projectId ?? dataContext.project?.id ?? null;
  return useMemo(
    () => buildTerminalRows(tabs ?? [], pid, knownIds(shells, processes)),
    // shells/processes drive re-render on live status/name changes.
    [tabs, shells, processes, pid],
  );
}

/** Imperative snapshot of terminal rows for route loaders (outside React). */
export async function getTerminalTabsSnapshot(projectId?: string | null): Promise<TerminalTab[]> {
  const [tabs, shells, processes] = await Promise.all([
    Tab.query<Tab>(VISIBLE_TABS_QUERY),
    Shell.query<Shell>(ALL_SHELLS_QUERY).catch(() => [] as Shell[]),
    AgenticProcess.query<AgenticProcess>(ALL_PROCESSES_QUERY).catch(() => [] as AgenticProcess[]),
  ]);
  return buildTerminalRows(
    tabs ?? [],
    projectId ?? dataContext.project?.id ?? null,
    knownIds(shells, processes),
  );
}

/** Soft-close the terminal tab backing a target TypeId (shell-<id> /
 *  agentic_process-<id>) — locates its visible Tab and closes it. */
export async function closeTerminalTab(target: TypeId | string): Promise<void> {
  let targetId = '';
  try {
    targetId = new TypeId(typeof target === 'string' ? target : target.toString()).id;
  } catch {
    return;
  }
  const visible = await Tab.query<Tab>(VISIBLE_TABS_QUERY);
  const match = (visible ?? []).find((t) => t.target_id === targetId);
  if (match) await match.closeTab();
}

export interface TerminalCloseResponse {
  accepted: string[];
  missing: string[];
  invalid: string[];
}

/**
 * Batched terminal close (`tabs/close`). ONE POST for N targets — never a
 * per-tab fan-out (locked by `terminal-close-all-race.test.ts`). The backend
 * tears down each PTY/worker; the entity-delete then fires the orphan-Tab
 * cleanup, and the live `Tab` query drops the rows.
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
  return {
    accepted: result?.accepted ?? [],
    missing: result?.missing ?? [],
    invalid: result?.invalid ?? [],
  };
}

/** Historical name — terminal call sites close through the same batched POST. */
export const closeTerminalTargets = closeTabTargets;

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
  const tabs = useTerminalTabs();

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
