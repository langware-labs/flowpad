import { Layout, VFSPath, dataContext } from '@sdk';
import { LOCAL_COMPUTE_NODE } from './asset-doc-types';
import { DockPointer } from './DockPointer';
import { vfsLocatorForComputeNode } from './vfs-locator';

/**
 * Where a FOLDER opens: the Assets fs browser, addressed on the live compute node.
 * Converts an absolute machine path (POSIX `/…` or Windows `C:\…`) to the
 * compute-node-relative form the `fs/` pointer expects. `select` names an entry
 * of the folder to show selected.
 */
export function folderDockPointer(machinePath: string, select?: string): DockPointer {
  const parsed = VFSPath.parse(machinePath);
  if (parsed.isAbsolute) return DockPointer.forAssetFs(parsed, Layout.DOCK, select);
  const liveTypeId = dataContext.computeNodeTypeId ?? LOCAL_COMPUTE_NODE;
  const locatorTypeId = vfsLocatorForComputeNode(dataContext.computeNode) ?? liveTypeId;
  const vfsPath =
    machinePath.startsWith('/') || /^[A-Za-z]:[/\\]/.test(machinePath)
      ? VFSPath.fromMachinePath(machinePath, locatorTypeId)
      : VFSPath.fromTypeId(locatorTypeId, machinePath);
  return DockPointer.forAssetFs(vfsPath, Layout.DOCK, select);
}
