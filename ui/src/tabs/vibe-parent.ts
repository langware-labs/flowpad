import { AgenticProcess, dataContext, dataManager, QueryRequest, Tab } from '@sdk';
import { getViewMode, ViewMode } from '@src/contexts/view-mode-context';
import { DockPointer } from '@src/navigation/DockPointer';
import { createVibeProcessForProject } from '@src/pages/flow-page/use-start-vibe-session';

/**
 * Vibe invariant: an entity opened while in vibe mode must land inside a vibe
 * workspace. The workspace is a HOST layout over a PROCESS tab, and — one tab
 * per process — a content tab can only join the workspace as a CHILD of that
 * process tab (`parent_tab_id`). So opening an asset in vibe needs a process to
 * parent under.
 *
 * While the workspace is already mounted it registers the parent itself
 * (`tab-parent-context`); this module owns the COLD path — a direct link /
 * reload where no workspace is mounted. `resolveColdOpenParent` is the single
 * entry the tab chokepoint (`materializeTab`) calls; it keeps the chokepoint
 * mode-agnostic — it returns null unless the dock is a vibe asset open, in
 * which case it resolves the asset's project → the project's most-recently-
 * active process (creating an empty headless vibe process if none) → and
 * returns THAT process's tab id to use as the asset tab's `parent_tab_id`.
 */

/** Effective view mode for a dock: its `?viewMode` override, else the persisted
 *  default. Vibe means asset opens must render inside a vibe workspace. */
function isVibeDock(dock: DockPointer): boolean {
  return (dock.viewMode ?? getViewMode()) === ViewMode.Vibe;
}

/** Project id the asset dock's tab will belong to — resolved from the target
 *  entity exactly as Tab minting does, falling back to the active project. */
async function projectIdForAssetDock(dock: DockPointer): Promise<string | null> {
  const tid = dock.targetTypeId;
  if (tid) {
    const ent = await dataManager.getByTypeId<{ project_id?: string | null }>(tid).catch(() => null);
    if (ent?.project_id) return ent.project_id;
  }
  if (dock.vfsPath) {
    const ent = await dataManager
      .getEntityByPath<{ project_id?: string | null }>(dock.vfsPath.machinePath)
      .catch(() => null);
    if (ent?.project_id) return ent.project_id;
  }
  return dataContext.project?.id ?? null;
}

/** The process's own tab id (minting it if the row doesn't exist yet). */
async function processTabId(proc: AgenticProcess): Promise<string | null> {
  const dock = new DockPointer(proc.terminalDockPointer);
  const tabs = await Tab.getFromDockPointer(dock).catch(() => [] as Tab[]);
  const hash = dock.tabHash;
  return tabs.find((t) => t.dockPointer?.tabHash === hash)?.id ?? null;
}

/** Resolve the project's most-recently-active process; else create an empty
 *  headless vibe process (no navigate) purely to host the tab. */
async function resolveOrCreateVibeParentTabId(projectId: string): Promise<string | null> {
  const procs = await AgenticProcess.query<AgenticProcess>(
    new QueryRequest({ type: AgenticProcess.type, scope: [] }),
  ).catch(() => [] as AgenticProcess[]);
  const pick = procs
    .filter((p) => p.project_id === projectId)
    .sort((a, b) => (Number(b.last_active_at) || 0) - (Number(a.last_active_at) || 0))[0];
  if (pick) return processTabId(pick);

  const workdir =
    dataContext.project?.id === projectId ? dataContext.project?.fs_storage_mount_path : undefined;
  const proc = await createVibeProcessForProject({ projectId, workdir, open: false });
  return processTabId(proc);
}

/**
 * Cold-open parent for the tab chokepoint. Returns the parent tab id when `dock`
 * is an asset opened in vibe mode (resolving-or-creating the project's process),
 * else null — so `materializeTab` can call it unconditionally without knowing
 * about vibe. `knownProjectId` short-circuits the target lookup when the tab
 * already carries its project.
 */
export async function resolveColdOpenParent(
  dock: DockPointer,
  knownProjectId: string | null,
): Promise<string | null> {
  if (!isVibeDock(dock)) return null;
  const projectId = knownProjectId ?? (await projectIdForAssetDock(dock));
  if (!projectId) return null;
  return resolveOrCreateVibeParentTabId(projectId);
}
