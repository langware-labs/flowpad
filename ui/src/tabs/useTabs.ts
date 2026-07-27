import {
  AgenticProcess,
  ConnectionManager,
  dataContext,
  type DataOpType,
  type IEntity,
  Project,
  Shell,
  Tab,
  TypeId,
  type ITab,
} from '@sdk';
import { useContext } from '@sdk/react/hooks';
import { coerceTab, getAllTabsSnapshot, refreshAllTabs, useAllTabs } from '@src/tabs/all-tabs-store';
import { tabInProject } from '@src/tabs/tab-candidates';
import { useEffect, useMemo, useState } from 'react';

// ─── Tab filtering and access ─────────────────────────────────────────────────

const TERMINAL_TARGET_TYPES = new Set<string>([Shell.type, AgenticProcess.type]);

/** The canonical strip chip key for a tab (its tabHash, else the raw id). The
 *  ONE place this fallback rule lives — every strip must key chips by this so
 *  select/close-by-key stay in lockstep. */
export function tabKey(tab: Tab): string {
  return tab.dockPointer?.tabHash ?? tab.id;
}

export function uniqueTabsByDockKey(tabs: Tab[]): Tab[] {
  const seen = new Set<string>();
  return tabs.filter((tab) => {
    const key = tabKey(tab);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Terminal tabs (Shell + AgenticProcess targets) for a scope, in backend global order.
 *  `'all'` = every project (the developer sessions view); `'project'` = the active
 *  project + projectless. */
export function terminalTabsForScope(
  tabs: Array<Tab | ITab>,
  scope: 'project' | 'all',
  projectId: string | null,
): Tab[] {
  const terminals = tabs.map(coerceTab).filter((t) => TERMINAL_TARGET_TYPES.has(t.target_type ?? ''));
  if (scope === 'all') return uniqueTabsByDockKey(terminals);
  return uniqueTabsByDockKey(terminals.filter((t) => tabInProject(t, projectId)));
}

/** THE strip-partition rule: a tab with a `parent_tab_id` is a workspace CHILD
 *  (a content tab a vibe workspace opened) and renders ONLY in its workspace's
 *  child strip — never as a top-level chip. Every top-level tab-list consumer
 *  must apply (or consciously decline) this predicate; `terminalTabsForScope`
 *  and `useTabProjectBuckets` decline — children are content tabs by the
 *  backend invariant, so they never appear in the terminal rails, and they DO
 *  count as a project's open tabs. */
export function isWorkspaceChild(tab: Tab | ITab): boolean {
  return tab.parent_tab_id != null;
}

/** Tabs for the current active project + projectless (the render view for the
 *  unified tab strip). Workspace children excluded — see `isWorkspaceChild`. */
export function useCurrentTabs(): Tab[] {
  const all = useAllTabs();
  const { project } = useContext();
  return useMemo(
    () =>
      uniqueTabsByDockKey(
        all.filter((t) => !isWorkspaceChild(t) && tabInProject(t, project?.id ?? null)),
      ),
    [all, project?.id],
  );
}

/** Set of `tabHash`es for all currently-open tabs. Powers rail "dim entries that
 *  have no open tab" — a Browseable row whose `pointer.tabHash` is in this set is
 *  open and stays bright; everything else dims. */
export function useOpenTabHashes(): Set<string> {
  const all = useAllTabs();
  return useMemo(() => new Set(all.map((t) => t.dockPointer?.tabHash).filter(Boolean) as string[]), [all]);
}

/** Set of target ids (AgenticProcess/Shell) that currently back a tab. Same
 *  dimming rule as `useOpenTabHashes`, but for the custom-row rails (Chats) that
 *  match by `target_id` rather than by a DockPointer. */
export function useOpenTabTargetIds(): Set<string> {
  const all = useAllTabs();
  return useMemo(() => new Set(all.map((t) => t.target_id).filter(Boolean) as string[]), [all]);
}

/** React binding for terminal tabs, reading the global store. */
export function useTerminalTabs(scope: 'project' | 'all' = 'project', projectId?: string | null): Tab[] {
  const tabs = useAllTabs();
  const pid = projectId ?? dataContext.project?.id ?? null;
  return useMemo(() => terminalTabsForScope(tabs, scope, pid), [tabs, scope, pid]);
}

/** Imperative snapshot of terminal tabs for route loaders (outside React).
 *  Fetches the canonical global list, then scopes it. */
export async function getTerminalTabsSnapshot(
  scope: 'project' | 'all' = 'all',
  projectId?: string | null,
): Promise<Tab[]> {
  const tabs = await refreshAllTabs();
  return terminalTabsForScope(tabs, scope, projectId ?? dataContext.project?.id ?? null);
}

/** Resolve the visible Tab backing a terminal target TypeId (shell-<id> /
 *  agentic_process-<id>), or null. Reads the global store (loading it once if
 *  the snapshot is empty) and matches by denormalized `target_id`. */
async function tabForTarget(target: TypeId | string): Promise<Tab | null> {
  let targetId = '';
  try {
    targetId = new TypeId(typeof target === 'string' ? target : target.toString()).id;
  } catch {
    return null;
  }
  let tabs = getAllTabsSnapshot();
  if (tabs.length === 0) tabs = await refreshAllTabs();
  return tabs.find((t) => t.target_id === targetId) ?? null;
}

/** Soft-close the terminal tab backing a target TypeId (shell-<id> /
 *  agentic_process-<id>) — resolves its visible Tab and closes it by id
 *  through the `tab` close action (backend dispatches PTY/worker teardown). */
export async function closeTerminalTab(target: TypeId | string): Promise<void> {
  const tab = await tabForTarget(target);
  if (tab) await Tab.closeById(tab.id);
}

/**
 * User-initiated terminal rename — resolves the Tab by target and renames it
 * by id. The backend `rename` action sets `Tab.name` (fixing the inactive chip
 * label) and reflects onto the target entity via the generic `Entity.rename`
 * (mirrors `name`; shell/AP also pin `auto_rename=false`).
 */
export async function renameTerminalTab(target: TypeId | string, name: string): Promise<void> {
  const tab = await tabForTarget(target);
  if (tab) await Tab.renameById(tab.id, name);
}

/**
 * Mirror an entity-originated (PTY auto-title) rename onto the Tab label via the
 * `set_name` action — NOT `rename`, so it never resets `auto_rename`. Keeps an
 * inactive chip's label correct after the active tab auto-renames.
 */
export async function syncTerminalTabName(target: TypeId | string, name: string): Promise<void> {
  const tab = await tabForTarget(target);
  if (tab && tab.name !== name) await Tab.setNameById(tab.id, name);
}

/**
 * Mirror a transcript lens's resolved session name onto its Tab label.
 *
 * Transcript tabs (`lens/<worker>/transcript/<id>`) can't rely on the content
 * data-op mirror below: codex/copilot sessions have no entity to fire a data-op,
 * and legacy claude tabs were minted with a null `target_id` (so the
 * `target_id === id` match never hits). This resolves the tab by the current
 * dock's `tabHash` instead and `set_name`-mirrors the generic worker-session
 * name (from the transcript header) once known — `set_name`, not `rename`, so it
 * never pins `auto_rename`. Guarded + no-op when unchanged, so it's safe to run
 * from the read-only viewer on every load.
 */
export function useSyncTranscriptTabName(tabHash: string | null | undefined, name: string | null | undefined): void {
  const tabs = useAllTabs();
  useEffect(() => {
    const trimmed = name?.trim();
    if (!tabHash || !trimmed) return;
    const tab = tabs.find((t) => tabKey(t) === tabHash);
    if (tab && tab.name !== trimmed) {
      void Tab.setNameById(tab.id, trimmed).then(() => void refreshAllTabs());
    }
  }, [tabs, tabHash, name]);
}

/**
 * Generic entity → tab name sync. Mount once (the tab strip). A single
 * `on_data_op` listener mirrors a CONTENT entity's renamed `name` onto its tab
 * label via the tab-only `set_name` action — the same guarded mirror terminals
 * already use for PTY auto-titles, generalized so that renaming any backing
 * entity (e.g. a GraphContext in its sidebar) keeps the tab chip in step.
 *
 * Leak-safe: ONE listener, registered on mount and removed on cleanup; reads the
 * live tab snapshot at fire-time so it never re-subscribes. Terminals keep their
 * own `auto_rename`-aware path and are skipped. No-op unless the name changed.
 */
export function useSyncContentTabNames(): void {
  useEffect(() => {
    const cm = ConnectionManager.getInstance();
    const handler = (_typeIdStr: string, op: DataOpType, data: IEntity) => {
      if (op === 'delete') return;
      // Skip terminal-type ops before scanning tabs — shells/agentic-processes
      // stream frequent status data-ops and keep their own auto-rename path.
      const type = (data as { type?: string | null } | null)?.type;
      if (type && TERMINAL_TARGET_TYPES.has(type)) return;
      const id = data?.id;
      const name = (data as { name?: string | null } | null)?.name;
      const remote = (data as { remote?: unknown } | null)?.remote;
      if (!type || !id) return;
      const tab = getAllTabsSnapshot().find(
        (candidate) => candidate.target_type === type && candidate.target_id === id,
      );
      if (!tab) return;
      const nameChanged = typeof name === 'string' && name.length > 0 && tab.name !== name;
      const remoteChanged = typeof remote === 'boolean' && tab.target_remote !== remote;
      if (!nameChanged && !remoteChanged) return;
      void (async () => {
        if (nameChanged) await Tab.setNameById(tab.id, name);
        await refreshAllTabs();
      })();
    };
    cm.on('on_data_op', handler);
    return () => {
      cm.off('on_data_op', handler);
    };
  }, []);
}

// ─── Project-bucketed view (chip consumes this) ─────────────────────────────

export type BucketState = 'loading' | 'live' | 'missing';

export interface TabProjectBucket {
  /** Stable bucket identity. For stranded buckets this is still the dangling
   *  project_id — the tab exists, the Project entity just doesn't. */
  projectId: string;
  /** Resolved Project entity. Non-null iff ``state === 'live'``. */
  project: Project | null;
  /** 'loading' = cache miss, fetch in flight or pending; 'live' = entity
   *  resolved; 'missing' = backend confirmed 404 (stranded). */
  state: BucketState;
  /** Number of open (visible) tabs the project owns — across ALL kinds. */
  tabCount: number;
  /** Resurrect the Project from a tab's workdir + rebind every dependent's
   *  project_id (server-side). Only meaningful when ``state === 'missing'``. */
  recover: () => Promise<Project | null>;
}

export interface UseTabProjectBucketsResult {
  buckets: TabProjectBucket[];
  /** Number of visible projectless ("global") tabs — the Global scope's count.
   *  Kind-agnostic, same as a project bucket's `tabCount`. Powers the Global chip
   *  (which is shown only in the no-active-project scope). */
  globalTabCount: number;
}

/**
 * Bucket the global tab list by ``project_id`` and resolve each bucket's Project.
 * Single owner of the "which projects own which tabs" question — consumers (e.g.
 * ProjectsCounterChip) render tabs straight from this hook.
 *
 * Membership is KIND-AGNOSTIC: every visible `Tab` counts (terminal, agent,
 * markdown, skill, …). Reads the same `all-tabs-store` projection the terminal
 * tabs use — no separate query. Global tabs (`project_id == null`) don't form a
 * project bucket; they are tallied separately into `globalTabCount` (the Global
 * scope), which the chip surfaces only when no project is active.
 */
export function useTabProjectBuckets(): UseTabProjectBucketsResult {
  const allTabs = useAllTabs();

  const { grouped, globalTabCount } = useMemo(() => {
    const counts = new Map<string, number>();
    let global = 0;
    for (const tab of allTabs) {
      const pid = tab.project_id ?? null;
      if (!pid) {
        // Projectless tab → the Global scope. There is no per-project "host" tab
        // to skip here (a project's landing host carries the project's own id,
        // never null), so every visible projectless tab counts.
        global += 1;
        continue;
      }
      // Skip a project's OWN landing/brief host tab (target === the project
      // itself): `DockPointer.forProject` — where last-tab-close navigates —
      // materializes a visible `project`-target Tab, but that is the empty-state
      // host, not a real open tab. Counting it left the chip advertising "1 tab"
      // for a project the brief correctly showed as empty. Membership in this
      // chip means ≥1 real (content/terminal) tab; a project re-earns its slot
      // when an actual session/content tab opens.
      if (tab.target_type === Project.type) continue;
      counts.set(pid, (counts.get(pid) ?? 0) + 1);
    }
    return { grouped: Array.from(counts.entries()), globalTabCount: global };
  }, [allTabs]);

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
      const state: BucketState = cached ? 'live' : resolved === 'missing' ? 'missing' : 'loading';
      const project = state === 'live' ? cached : null;
      const recover = async (): Promise<Project | null> => {
        if (project) return project;
        const computeNodeId = dataContext.computeNode?.id;
        if (!computeNodeId) return null;
        const recovered = await Project.recoverOrphaned(projectId, computeNodeId).catch(() => null);
        if (!recovered) return null;
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

  return { buckets, globalTabCount };
}

// Backward-compat aliases for migration
export const useTerminalTabRows = useTerminalTabs;
export const getTerminalTabRowsSnapshot = getTerminalTabsSnapshot;
export const terminalRowsForScope = terminalTabsForScope;
