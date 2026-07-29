import { AgenticProcess, dataContext, Tab } from '@sdk';
import { getViewMode, ViewMode } from '@src/contexts/view-mode-context';
import { contentAssetTargetForDock } from '@src/navigation/content-asset-dock';
import { DockPointer } from '@src/navigation/DockPointer';
import { resolveTargetVibeChat } from '@src/pages/flow-page/vibe-process-resolver';
import { createVibeProcessForProject } from '@src/pages/flow-page/use-start-vibe-session';

/**
 * Vibe invariant: an entity opened while in vibe mode must land inside a vibe
 * workspace. The workspace is a HOST layout over a PROCESS tab, and — one tab
 * per process — a content tab can only join the workspace as a CHILD of that
 * process tab (`parent_tab_id`). So opening an asset in vibe needs a process to
 * parent under.
 *
 * The stable asset workspace calls `resolveColdOpenParent` after the route
 * loader has resolved the asset. It resolves the asset's project → the newest
 * process keyed to that exact asset (creating an empty headless vibe process if
 * none) → and returns THAT process's tab id so the asset tab can adopt it as
 * `parent_tab_id`.
 */

/** Effective view mode for a dock: its `?viewMode` override, else the persisted
 *  default. Vibe means asset opens must render inside a vibe workspace. */
function isVibeDock(dock: DockPointer): boolean {
  return (dock.viewMode ?? getViewMode()) === ViewMode.Vibe;
}

/** The process's own tab id (minting it if the row doesn't exist yet). */
async function processTab(proc: AgenticProcess): Promise<Tab | null> {
  const dock = new DockPointer(proc.terminalDockPointer);
  const pointer = dock.toJSON();
  if (!pointer) return null;
  // The process entity is already resolved. Calling getFromDockPointer here
  // would resolve the same target a second time before it can mint/reopen its
  // tab, serializing a mode-only transition behind unrelated entity work.
  const tabs = await Tab.newTab(pointer, {
    targetType: AgenticProcess.type,
    targetId: proc.id,
    projectId: proc.project_id ?? null,
    name: proc.hasSyntheticDisplayName ? null : proc.displayName,
    iconKey: proc.icon,
    worktree: Boolean(proc.cliOptions.worktree),
  }).catch(() => [] as Tab[]);
  const hash = dock.tabHash;
  // The backend's one-tab-per-process identity is the target pair. Prefer it
  // over a client-side pointer hash comparison: canonical pointer healing may
  // add/remove presentation options while retaining the same process row.
  return (
    tabs.find(
      (tab) =>
        tab.target_type === AgenticProcess.type && tab.target_id === proc.id,
    ) ??
    tabs.find((tab) => tab.dockPointer?.tabHash === hash) ??
    null
  );
}

export interface ResolvedAssetVibeHost {
  process: AgenticProcess;
  projectId: string;
  targetVfsPath: string;
}

/** Resolve the target-keyed process without waiting for tab materialization. */
export async function resolveAssetVibeHost(
  dock: DockPointer,
): Promise<ResolvedAssetVibeHost | null> {
  if (!isVibeDock(dock)) return null;
  const target = contentAssetTargetForDock(dock, dock.targetTypeId);
  if (!target) return null;
  const projectId =
    dock.scopeProjectId ?? (await Tab.resolveDockTarget(dock)).projectId;
  if (!projectId) return null;

  const targetVfsPath = target.targetVfsPath;
  const pick = await resolveTargetVibeChat(projectId, targetVfsPath).catch(() => null);
  const process =
    pick ??
    (await createVibeProcessForProject({
      projectId,
      workdir:
        dataContext.project?.id === projectId
          ? dataContext.project?.fs_storage_mount_path
          : undefined,
      targetVfsPath,
      open: false,
    }));
  return { process, projectId, targetVfsPath };
}

/** Ensure the already-resolved host process has its canonical process tab. */
export function ensureAssetVibeParentTab(
  host: ResolvedAssetVibeHost,
): Promise<Tab | null> {
  return processTab(host.process);
}

/**
 * Resolve the process-tab parent for an asset opened in Vibe. Project and
 * entity identity use the same canonical dock resolver as tab minting.
 */
export async function resolveColdOpenParent(dock: DockPointer): Promise<string | null> {
  const host = await resolveAssetVibeHost(dock);
  const tab = host ? await ensureAssetVibeParentTab(host) : null;
  return tab?.id ?? null;
}
