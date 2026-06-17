import { AgenticProcess, dataContext, Project, Shell, Tab, type TabRow, TypeId } from '@sdk';
import { getAllTabRowsSnapshot, refreshAllTabRows, useAllTabRows } from '@src/tabs/all-tabs-store';
import { tabRowInProject } from '@src/tabs/tab-candidates';
import { useEffect, useMemo, useState } from 'react';

// ─── Terminal rows (docs/tab-management.md) ─────────────────────────────────
// Terminal tabs are driven entirely by the backend `Tab` (the `tab` action). The
// strip + body render straight off `TabRow`; the only client-side join is each
// mounted panel hydrating its own live entity. There is no `TerminalTab`
// view-model and no reactive entity query.

const TERMINAL_TARGET_TYPES = new Set<string>([Shell.type, AgenticProcess.type]);

/** Terminal-target `TabRow`s for a scope, in backend global order. `'all'` = every
 *  project (the developer sessions view); `'project'` = the active project +
 *  projectless (the `filter_for_project` view). */
export function terminalRowsForScope(
  rows: TabRow[],
  scope: 'project' | 'all',
  projectId: string | null,
): TabRow[] {
  const terminals = rows.filter((r) => TERMINAL_TARGET_TYPES.has(r.target_type ?? ''));
  if (scope === 'all') return terminals;
  return terminals.filter((r) => tabRowInProject(r, projectId));
}

/** React binding for {@link terminalRowsForScope}, reading the one global store. */
export function useTerminalTabRows(
  scope: 'project' | 'all' = 'project',
  projectId?: string | null,
): TabRow[] {
  const rows = useAllTabRows();
  const pid = projectId ?? dataContext.project?.id ?? null;
  return useMemo(() => terminalRowsForScope(rows, scope, pid), [rows, scope, pid]);
}

/** Imperative snapshot of terminal `TabRow`s for route loaders (outside React).
 *  Fetches the canonical global list, then scopes it. */
export async function getTerminalTabRowsSnapshot(
  scope: 'project' | 'all' = 'all',
  projectId?: string | null,
): Promise<TabRow[]> {
  const rows = await refreshAllTabRows();
  return terminalRowsForScope(rows, scope, projectId ?? dataContext.project?.id ?? null);
}

/** Resolve the visible Tab row backing a terminal target TypeId (shell-<id> /
 *  agentic_process-<id>), or null. Reads the global store (loading it once if the
 *  snapshot is empty) and matches by denormalized `target_id`. */
async function tabRowForTarget(target: TypeId | string): Promise<TabRow | null> {
  let targetId = '';
  try {
    targetId = new TypeId(typeof target === 'string' ? target : target.toString()).id;
  } catch {
    return null;
  }
  let rows = getAllTabRowsSnapshot();
  if (rows.length === 0) rows = await refreshAllTabRows();
  return rows.find((t) => t.target_id === targetId) ?? null;
}

/** Soft-close the terminal tab backing a target TypeId (shell-<id> /
 *  agentic_process-<id>) — resolves its visible Tab row and closes it by id
 *  through the `tab` close action (backend dispatches PTY/worker teardown). */
export async function closeTerminalTab(target: TypeId | string): Promise<void> {
  const row = await tabRowForTarget(target);
  if (row) await Tab.closeById(row.id);
}

/**
 * User-initiated terminal rename — resolves the Tab row by target and renames it
 * by id. The backend `rename` action sets `Tab.name` (fixing the inactive chip
 * label) and reflects onto the target entity via the generic `Entity.rename`
 * (mirrors `name`; shell/AP also pin `auto_rename=false`).
 */
export async function renameTerminalTab(target: TypeId | string, name: string): Promise<void> {
  const row = await tabRowForTarget(target);
  if (row) await Tab.renameById(row.id, name);
}

/**
 * Mirror an entity-originated (PTY auto-title) rename onto the Tab label via the
 * `set_name` action — NOT `rename`, so it never resets `auto_rename`. Keeps an
 * inactive chip's label correct after the active tab auto-renames.
 */
export async function syncTerminalTabName(target: TypeId | string, name: string): Promise<void> {
  const row = await tabRowForTarget(target);
  if (row && row.name !== name) await Tab.setNameById(row.id, name);
}

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
  /** Number of open (visible) tabs the project owns — across ALL kinds. */
  tabCount: number;
  /** Resurrect the Project from a tab's workdir + rebind every dependent's
   *  project_id (server-side). Only meaningful when ``state === 'missing'``. */
  recover: () => Promise<Project | null>;
}

export interface UseTabProjectBucketsResult {
  buckets: TabProjectBucket[];
}

/**
 * Bucket the global tab list by ``project_id`` and resolve each bucket's Project.
 * Single owner of the "which projects own which tabs" question — consumers (e.g.
 * ProjectsCounterChip) render rows straight from this hook.
 *
 * Membership is KIND-AGNOSTIC: every visible `Tab` counts (terminal, agent,
 * markdown, skill, …). Reads the same `all-tabs-store` projection the terminal
 * rows use — no separate query. Global tabs (`project_id == null`) never bucket.
 */
export function useTabProjectBuckets(): UseTabProjectBucketsResult {
  const allTabs = useAllTabRows();

  const grouped = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tab of allTabs) {
      const pid = tab.project_id ?? null;
      if (!pid) continue;
      counts.set(pid, (counts.get(pid) ?? 0) + 1);
    }
    return Array.from(counts.entries());
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

  return { buckets };
}
