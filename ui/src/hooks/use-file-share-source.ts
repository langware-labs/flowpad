import { useEffect, useState } from 'react';
import { ActionInfo, dataManager, TypeId } from '@sdk';
import { fileShareSource, genericEntityShareSource, type ShareSource } from '@src/hooks/share-sources';

/**
 * The share source for one file: the artifact the backend registers for it, so
 * the dialog can preflight sending a git pointer the receiver opens at the
 * shared commit (or a copy). A file the backend cannot resolve (not on this
 * machine) is the plain file copy.
 *
 * `null` while there is nothing to share, or while the page's artifact resolves.
 */
export function useFileShareSource(
  computeNodeTypeId: TypeId | null | undefined,
  absPath: string | null,
): ShareSource | null {
  const [source, setSource] = useState<ShareSource | null>(null);
  const nodeKey = computeNodeTypeId?.toString() ?? '';

  useEffect(() => {
    if (!computeNodeTypeId || !absPath) {
      setSource(null);
      return;
    }
    const copy = fileShareSource({ computeNodeTypeId, absPath });
    let live = true;
    setSource(null);
    const action = new ActionInfo('shared-file-artifact', null, null, 'POST');
    action.bodyParameters = { path: absPath };
    void dataManager
      .callAction<{ path: string }, { type_id: string; name: string | null }>(action)
      .then((res) => {
        if (!live) return;
        setSource(genericEntityShareSource(new TypeId(res.type_id), { label: res.name ?? undefined }));
      })
      .catch(() => live && setSource(copy));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeKey, absPath]);

  return source;
}
