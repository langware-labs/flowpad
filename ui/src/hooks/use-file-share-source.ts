import { useEffect, useState } from 'react';
import { ActionInfo, dataManager, TypeId } from '@sdk';
import { fileShareSource, genericEntityShareSource, type ShareSource } from '@src/hooks/share-sources';

/**
 * The share source for one file. A file the backend says travels as an
 * artifact (a standalone `.html` page) is shared as the artifact that names it — so the dialog can offer (and preflight) sending a
 * git pointer the receiver opens at the shared commit. Anything else, or a page
 * the backend cannot resolve (not on this machine), is the plain file copy.
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
    // The backend decides which files travel as an artifact (a git pointer):
    // it answers `type_id: null` for a file that is shared as itself.
    let live = true;
    setSource(null);
    const action = new ActionInfo('shared-file-artifact', null, null, 'POST');
    action.bodyParameters = { path: absPath };
    void dataManager
      .callAction<{ path: string }, { type_id: string | null; name: string | null }>(action)
      .then((res) => {
        if (!live) return;
        setSource(
          res?.type_id ? genericEntityShareSource(new TypeId(res.type_id), { label: res.name ?? undefined }) : copy,
        );
      })
      .catch(() => live && setSource(copy));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeKey, absPath]);

  return source;
}
