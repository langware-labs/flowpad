import { AgenticProcess, dataContext, TypeId, VFSPath } from '@sdk';
import { useCallback, useMemo } from 'react';

import { useDockNavigation } from '@src/navigation';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';
import { DockPointer } from '@src/navigation/DockPointer';
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
 *  3. rebase an assets pointer onto the process's project so it gets its own
 *     tab — the same move, for the same reason, as `use-show-target-listener`.
 *
 * URL-first: the click handler only navigates. No optimistic context writes.
 */
export function useOpenTurnFile(process?: AgenticProcess | null): TurnFileOpener {
  const { navigation } = useDockNavigation();
  const workdir = process?.workdir ?? null;
  const projectId = process?.project_id ?? null;

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
      // A process with no project still needs a rebase target, or its markdown
      // chip hijacks whatever Assets tab is already open.
      const scope = projectId ?? dataContext.project?.id ?? null;
      navigation.openDock(DockPointer.rebaseAssetsOntoProject(dockPointerForFile(vfsPath), scope));
    },
    [resolve, navigation, projectId],
  );

  return { resolve, open };
}
