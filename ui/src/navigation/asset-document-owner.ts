import { dataManager, resolveTabProject, type AnyEntity, type TabProjectTarget } from '@sdk';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { ViewType } from '@src/types/ViewType';
import { DockPointer } from './DockPointer';

/**
 * An unscoped, unhosted Assets DOCUMENT dock (an `editor/…` or `wiki/…` sub-pointer,
 * vfs or typeid) rebased onto the project that owns it — or null when it is not such a
 * dock, or no project owns it (it stays global).
 *
 * The owner is `resolveTabProject`'s owner steps: the target entity's project, else the
 * deepest project mount holding its path (an unminted file too). Cache-first reads.
 * Shared by the loader's RESOLVE redirect and by clicks that place a tab before
 * navigating, so neither folds a document into the `assets|all` browser tab.
 */
export async function assetDocumentAtOwner(dock: DockPointer): Promise<DockPointer | null> {
  if (dock.viewType !== ViewType.ASSETS || dock.scopeFilter || dock.hostProcessId || isHubOnly()) return null;
  if (!/^(editor|wiki)\//.test(dock.pointer ?? '')) return null;
  const typeId = dock.targetTypeId;
  const machinePath = dock.vfsPath?.machinePath;
  if (!typeId && !machinePath) return null;
  const target = typeId
    ? await dataManager.getByTypeId<AnyEntity>(typeId).catch(() => null)
    : await dataManager.getEntityByPath<AnyEntity>(machinePath!).catch(() => null);
  const owner = await resolveTabProject(dock, target as TabProjectTarget, { ownerOnly: true });
  return owner ? DockPointer.rebaseAssetsOntoProject(dock, owner) : null;
}
