import { dataContext, dataManager, isContentSubPointer, Project, tabOwnerProject, type AnyEntity, type TabProjectTarget } from '@sdk';
import { ViewType } from '@src/types/ViewType';
import { DockPointer } from './DockPointer';

/**
 * An unscoped, unhosted Assets DOCUMENT dock (an `editor/…` or `wiki/…` sub-pointer,
 * vfs or typeid) rebased onto the project that owns it — or null when it is not such a
 * dock, or no project owns it (it stays global).
 *
 * The owner is `tabOwnerProject` (Project target, the target's project, the deepest
 * project mount holding its path — an unminted file too). A path-addressed document
 * follows the backend order — its entity's project before its path — cache-first: the
 * cached entity at that path, else the cached project mounts. Only when neither answers
 * does it pay one network `getEntityByPath` (a file whose row isn't cached yet).
 */
export async function assetDocumentAtOwner(dock: DockPointer): Promise<DockPointer | null> {
  // Owners are project mounts on this backend's disk: a backend without one (the hub) rebases nothing.
  if (dock.viewType !== ViewType.ASSETS || dock.scopeFilter || dock.hostProcessId || !dataContext.caps.localFiles) return null;
  if (!isContentSubPointer(dock.pointer)) return null;
  const typeId = dock.targetTypeId;
  const machinePath = dock.vfsPath?.machinePath;
  let owner: string | null = null;
  if (typeId) {
    const target = await dataManager.getByTypeId<AnyEntity>(typeId).catch(() => null);
    owner = await tabOwnerProject(dock, target as TabProjectTarget);
  } else if (machinePath) {
    const cached = dataManager.findInCache((e) => (e as { asset_ref?: string }).asset_ref === machinePath);
    owner = cached
      ? await tabOwnerProject(dock, cached as TabProjectTarget)
      : ((await Project.getProjectByPath(machinePath))?.id ?? null);
    if (!owner && !cached) {
      const target = await dataManager.getEntityByPath<AnyEntity>(machinePath).catch(() => null);
      owner = target ? await tabOwnerProject(dock, target as TabProjectTarget) : null;
    }
  }
  if (!owner) return null;
  return DockPointer.rebaseAssetsOntoProject(dock, owner);
}
