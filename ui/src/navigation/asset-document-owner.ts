import { dataManager, isContentSubPointer, Project, resolveTabProject, type AnyEntity, type TabProjectTarget } from '@sdk';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { ViewType } from '@src/types/ViewType';
import { DockPointer } from './DockPointer';

/**
 * An unscoped, unhosted Assets DOCUMENT dock (an `editor/…` or `wiki/…` sub-pointer,
 * vfs or typeid) rebased onto the project that owns it — or null when it is not such a
 * dock, or no project owns it (it stays global).
 *
 * The owner is `resolveTabProject`'s owner steps (Project target, the target's project,
 * the deepest project mount holding its path — an unminted file too). Cache-first: a
 * path-addressed document asks the cached project list first and reads its entity only
 * when no mount holds the path.
 */
export async function assetDocumentAtOwner(dock: DockPointer): Promise<DockPointer | null> {
  if (dock.viewType !== ViewType.ASSETS || dock.scopeFilter || dock.hostProcessId || isHubOnly()) return null;
  if (!isContentSubPointer(dock.pointer)) return null;
  const typeId = dock.targetTypeId;
  const machinePath = dock.vfsPath?.machinePath;
  let owner: string | null = null;
  if (typeId) {
    const target = await dataManager.getByTypeId<AnyEntity>(typeId).catch(() => null);
    owner = await resolveTabProject(dock, target as TabProjectTarget, { ownerOnly: true });
  } else if (machinePath) {
    owner = (await Project.getProjectByPath(machinePath))?.id ?? null;
    if (!owner) {
      const target = await dataManager.getEntityByPath<AnyEntity>(machinePath).catch(() => null);
      owner = target ? await resolveTabProject(dock, target as TabProjectTarget, { ownerOnly: true }) : null;
    }
  }
  return owner ? DockPointer.rebaseAssetsOntoProject(dock, owner) : null;
}
