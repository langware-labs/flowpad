import { ContextEntitiesEnum, dataContext, type TypeId } from '@sdk';
import { useCallback, useEffect, useRef } from 'react';

/**
 * Snapshots the current project TypeId when `active` becomes true, and exposes
 * a `restore` function that reverts `dataContext` to that snapshot.
 *
 * Usage: capture on dialog open, call `restore()` on Cancel/Esc/X paths, call
 * `commit()` after a successful Create so subsequent closes don't revert.
 */
export function useProjectSnapshot(active: boolean) {
  const snapshotRef = useRef<TypeId | null>(null);
  const committedRef = useRef<boolean>(false);

  useEffect(() => {
    if (active) {
      snapshotRef.current = dataContext.projectTypeId;
      committedRef.current = false;
    }
  }, [active]);

  const restore = useCallback(async () => {
    if (committedRef.current) return;
    const snap = snapshotRef.current;
    if (snap == null) {
      await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, null);
    } else if (!dataContext.projectTypeId?.equals(snap)) {
      await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, snap);
    }
    await dataContext.refreshProject();
    const mount = dataContext.project?.fs_storage_mount_path ?? null;
    dataContext.setWorkdir(mount);
  }, []);

  const commit = useCallback(() => {
    committedRef.current = true;
  }, []);

  return { restore, commit };
}
