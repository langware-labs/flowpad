import { AgenticProcess, dataContext, TypeId, VFSPath } from '@sdk';
import { useCallback, useMemo } from 'react';

import { useDockNavigation } from '@src/navigation';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';
import { dockPointerForFile } from '@src/navigation/local-file-pointer';
import { vfsLocatorForComputeNode } from '@src/navigation/vfs-locator';

import { turnFileVfsPath } from './turnFilePath';

export interface TurnFileOpener {
  /** The VFS path a chip would open, or null — drives its disabled state. */
  resolve: (rawPath: string) => string | null;
  /** Open the file in its own tab. No-op when the path can't be resolved. */
  open: (rawPath: string) => void;
}

/**
 * Open a file the agent wrote or edited, in a tab of its own.
 *
 * Deliberately NOT `useChipTarget`/`openDisplayTarget`: those hand the raw
 * transcript path to `navigation.openFile`, which skips the machine→VFS
 * conversion (so code files 404 against the project root) and leaves an asset
 * pointer scope-keyed (so a `.md`/`.html` folds into the ONE Assets tab for the
 * scope and renames it instead of opening beside it). Both are fixed here:
 *
 *  1. resolve the vendor path to a VFS path (`turnFileVfsPath`);
 *  2. pick the viewer through the shared `dockPointerForFile` chokepoint;
 *  3. open the plain dock — the loader rebases a document onto the project
 *     folder holding it (a click is the file's own project, not the session's).
 *
 * URL-first: the click handler only navigates. No optimistic context writes.
 */
export function useOpenTurnFile(process?: AgenticProcess | null): TurnFileOpener {
  const { navigation } = useDockNavigation();
  const workdir = process?.workdir ?? null;

  // The node the AGENT ran on, not the node the browser happens to be looking
  // at: a process on a remote compute node wrote its files there. Its workdir
  // is the only value that always knows.
  const locator = useMemo<TypeId>(
    () => VFSPath.parse(workdir ?? '').typeId ?? vfsLocatorForComputeNode(dataContext.computeNode) ?? LOCAL_COMPUTE_NODE,
    [workdir],
  );

  const resolve = useCallback(
    (rawPath: string) => turnFileVfsPath(rawPath, { workdir, locator }),
    [workdir, locator],
  );

  const open = useCallback(
    (rawPath: string) => {
      const vfsPath = resolve(rawPath);
      if (!vfsPath) return;
      // The plain dock: the loader rebases the file onto the project folder
      // holding it (its own per-document tab), not onto the session's project.
      navigation.openDock(dockPointerForFile(vfsPath));
    },
    [resolve, navigation],
  );

  return { resolve, open };
}
