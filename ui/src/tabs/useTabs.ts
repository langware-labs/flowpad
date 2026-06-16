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
import { providerKindForWorkerType } from '@src/tabs/provider-kind';
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
   * tab remains the same targetTypeId. Best-effort: '' for an inactive process
   * tab whose entity isn't in cache (the active tab is always hydrated).
   */
  shellId: string;
  processId: string | null;
  tabOrder: number;
  name: string | null;
  type: TerminalTabType;
  /** Resolved provider/display kind ('shell'|'claude'|'codex'|'copilot'),
   *  denormalized on the `Tab` at creation — the chip's icon without an entity. */
  icon: string;
  /** Worktree badge flag, denormalized on the `Tab` at creation. */
  worktree: boolean;
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
// Terminal tabs are driven entirely by the `Tab` entity: the route loader
// materializes a Tab for every opened shell / agentic_process and stamps its
// display primitives (name/icon/worktree) at creation. The strip is ONE live
// query of `visible=true` Tabs — it never scans all shells/processes. The
// active tab's full entity is hydrated on demand by the route loader; the cache
// overlay below opportunistically enriches a row when its entity happens to be
// resident (e.g. the active tab), but a row renders fully from the Tab alone.

const TERMINAL_TARGET_TYPES = new Set<string>([Shell.type, AgenticProcess.type]);

// Single shared query (useEntitiesQuery keys by content, so the strip and this
// hook share one subscription). Liveness is the `visible` flag: the backend
// orphan-Tab cleanup / hide_tabs_for_target flips it on close/death, so a dead
// target simply drops out of this result — no all-entities scan needed.
const VISIBLE_TABS_QUERY = new QueryRequest({
  type: Tab.type,
  scope: [],
  name: 'tabs:visible',
  query: new QueryFilter({ match: { visible: true } }),
});

/** A terminal-target Tab row → TerminalTab. Built from the Tab's denormalized
 *  fields; when the backing entity is in cache (the active/mounted tab) its live
 *  name/status/shell_id overlay the static Tab values. Exported for the unit
 *  tests that lock the Tab→row mapping (ui/tests/unit/tab-*.test.ts). */
export function terminalTabFromTab(tab: Tab): TerminalTab | null {
  const targetId = tab.target_id ?? '';
  if (!targetId) return null;
  const projectId = tab.project_id ?? null;

  if (tab.target_type === Shell.type) {
    const cached = shellFromCache(targetId);
    // Liveness is the `visible` flag (dead targets drop out of the query via the
    // backend orphan cleanup), so this status overlay is a best-effort "Closing…"
    // affordance for the cached (active) tab only — undefined status ⇒ enabled.
    const isClosing = cached?.status === ShellStatus.CLOSING;
    return {
      targetTypeId: new TypeId(Shell.type, targetId),
      shellId: targetId,
      processId: null,
      tabOrder: tab.tab_order ?? 0,
      // Live shell name wins (PTY auto-rename); Tab.name is the create-time label.
      name: cached?.name ?? tab.name ?? null,
      type: 'plain',
      icon: tab.icon_key ?? 'shell',
      worktree: tab.worktree ?? false,
      isDisabled: isClosing,
      statusReason: isClosing ? 'Closing...' : '',
      projectId,
      projectDisplayName: null,
      shell: cached,
      lastActiveAt: tab.last_active_at,
    };
  }
  if (tab.target_type === AgenticProcess.type) {
    const cached = processFromCache(targetId);
    const linkedShellId = cached?.shell_id ?? '';
    const linkedShell = linkedShellId ? shellFromCache(linkedShellId) : undefined;
    const isClosing = linkedShell?.status === ShellStatus.CLOSING;
    return {
      targetTypeId: new TypeId(AgenticProcess.type, targetId),
      shellId: linkedShellId,
      processId: targetId,
      tabOrder: tab.tab_order ?? 0,
      // Source of truth: AgenticProcess.name when cached; else the Tab label.
      name: cached?.name ?? tab.name ?? null,
      type: 'claude',
      icon: tab.icon_key ?? providerKindForWorkerType(cached?.worker_type),
      worktree: tab.worktree ?? false,
      isDisabled: isClosing,
      statusReason: isClosing ? 'Closing...' : '',
      projectId,
      projectDisplayName: null,
      shell: linkedShell,
      agenticProcess: cached,
      lastActiveAt: tab.last_active_at,
    };
  }
  return null;
}

export function buildTerminalRows(tabs: Tab[], projectId: string | null): TerminalTab[] {
  const rows: TerminalTab[] = [];
  for (const t of tabs) {
    if (!TERMINAL_TARGET_TYPES.has(t.target_type ?? '')) continue;
    const row = terminalTabFromTab(t);
    if (row) rows.push(row);
  }
  const scoped = projectId == null ? rows : rows.filter((r) => r.projectId === projectId);
  return scoped.sort(byTabOrder);
}

/**
 * Terminal strip rows, sourced from the `Tab` entity alone. `tab_order` /
 * `last_active_at` / `name` / `icon` / `worktree` come from the Tab (durable
 * per-client order — no `mergePreservingOrder` needed). One query, no entity scan.
 */
export function useTerminalTabs(projectId?: string | null): TerminalTab[] {
  const { data: tabs } = useEntitiesQuery<Tab>(VISIBLE_TABS_QUERY);
  const pid = projectId ?? dataContext.project?.id ?? null;
  return useMemo(() => buildTerminalRows(tabs ?? [], pid), [tabs, pid]);
}

/** Imperative snapshot of terminal rows for route loaders (outside React). */
export async function getTerminalTabsSnapshot(projectId?: string | null): Promise<TerminalTab[]> {
  const tabs = await Tab.query<Tab>(VISIBLE_TABS_QUERY);
  return buildTerminalRows(tabs ?? [], projectId ?? dataContext.project?.id ?? null);
}

/** Resolve the visible Tab backing a terminal target TypeId (shell-<id> /
 *  agentic_process-<id>), or null. */
async function visibleTabForTarget(target: TypeId | string): Promise<Tab | null> {
  let targetId = '';
  try {
    targetId = new TypeId(typeof target === 'string' ? target : target.toString()).id;
  } catch {
    return null;
  }
  const visible = await Tab.query<Tab>(VISIBLE_TABS_QUERY);
  return (visible ?? []).find((t) => t.target_id === targetId) ?? null;
}

/** Soft-close the terminal tab backing a target TypeId (shell-<id> /
 *  agentic_process-<id>) — locates its visible Tab and closes it. */
export async function closeTerminalTab(target: TypeId | string): Promise<void> {
  const match = await visibleTabForTarget(target);
  if (match) await match.closeTab();
}

/**
 * User-initiated terminal rename — routed through the `Tab` so it works on any
 * chip without the backing entity in cache. The backend `rename` action sets
 * `Tab.name` (fixing the inactive chip label) and reflects onto the target
 * entity via the generic `Entity.rename` (mirrors `name`; shell/AP also pin
 * `auto_rename=false`).
 */
export async function renameTerminalTab(target: TypeId | string, name: string): Promise<void> {
  const tab = await visibleTabForTarget(target);
  if (tab) await tab.rename(name);
}

/**
 * Mirror an entity-originated (PTY auto-title) rename onto the Tab label with a
 * plain save — NOT the `rename` action, so it never resets `auto_rename`. Keeps
 * an inactive chip's label correct after the active tab auto-renames.
 */
export async function syncTerminalTabName(target: TypeId | string, name: string): Promise<void> {
  const tab = await visibleTabForTarget(target);
  if (tab && tab.name !== name) {
    tab.name = name;
    await tab.save();
  }
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

export interface TabProjectBucket {
  /** Stable bucket identity. For stranded buckets this is still the dangling
   *  project_id — the row exists, the Project entity just doesn't. */
  projectId: string;
  /** Resolved Project entity. Non-null iff ``state === 'live'``. */
  project: Project | null;
  /** 'loading' = cache miss, fetch in flight or pending; 'live' = entity
   *  resolved; 'missing' = backend confirmed 404 (stranded). */
  state: BucketState;
  /** Number of open (visible) tabs the project owns — across ALL kinds
   *  (terminal, agent, markdown, skill, …), the count badge in the chip. */
  tabCount: number;
  /** Resurrect the Project from a tab's workdir + rebind every dependent's
   *  project_id (server-side, via compute_node/recover-orphaned-project).
   *  Resolves to the recovered Project, or null on failure. Only meaningful
   *  when ``state === 'missing'``. */
  recover: () => Promise<Project | null>;
}

export interface UseTabProjectBucketsResult {
  buckets: TabProjectBucket[];
}

/**
 * Bucket the global tab strip by ``project_id`` and resolve each bucket's
 * Project entity. Single owner of the "which projects own which tabs" question
 * — consumers (e.g. ProjectsCounterChip) render rows straight from this hook
 * without doing their own bucketing or dangling-FK fallback.
 *
 * Membership is KIND-AGNOSTIC: every visible `Tab` counts, not just terminal /
 * agent tabs. A project whose only open tab is a markdown/skill/doc still gets a
 * bucket — that is the fix for "the project menu shows the wrong number of
 * projects" (it used to bucket terminal-target tabs only, so content-only
 * projects vanished from the list).
 *
 * Three bucket states:
 *   - ``loading``: cache miss, resolution in flight. Chip shows a placeholder.
 *   - ``live``: Project entity is in cache; bucket carries it.
 *   - ``missing``: backend returned 404 for the FK. Bucket exposes ``recover()``.
 *
 * Recovery is explicit — the hook does not auto-recover on mount (would re-enter
 * the auto-action antipattern called out in feedback memory).
 */
export function useTabProjectBuckets(): UseTabProjectBucketsResult {
  // The project-menu chip shows ONE row per project that owns an open tab, so it
  // buckets the UNSCOPED visible-tabs list directly off the `Tab` entities — any
  // `target_type`, never via `buildTerminalRows` (which drops content tabs and
  // scopes to the current project). Global tabs (`project_id == null`) are not a
  // project and never create a bucket.
  const { data: allTabs } = useEntitiesQuery<Tab>(VISIBLE_TABS_QUERY);

  const grouped = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tab of allTabs ?? []) {
      const pid = tab.project_id ?? null;
      if (!pid) continue;
      counts.set(pid, (counts.get(pid) ?? 0) + 1);
    }
    return Array.from(counts.entries());
  }, [allTabs]);

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

  const buckets = useMemo<TabProjectBucket[]>(() => {
    return grouped.map(([projectId, tabCount]) => {
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
      return { projectId, project, state, tabCount, recover };
    });
  }, [grouped, status]);

  return { buckets };
}
