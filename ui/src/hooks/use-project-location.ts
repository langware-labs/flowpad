import { useCallback, useMemo } from 'react';
import { fsManager } from '@sdk';
import { useContext } from '@src/hooks/useContext';

/**
 * The active project's display path and native folder opener.
 *
 * The footer and address bar are two projections of the same project location,
 * so the fallback order and filesystem action live here rather than drifting
 * between those surfaces.
 */
export function useProjectLocation() {
  const { project, computeNode, desktopInfo, workdir } = useContext();
  const workspacePath = desktopInfo?.paths?.workspace;

  const projectPath = useMemo(() => {
    if (workdir) return workdir;
    if (!project) return null;
    if (project.fs_storage_mount_path) return project.fs_storage_mount_path;
    if (workspacePath && project.displayName) return `${workspacePath}/${project.displayName}`;
    return project.name || project.displayName || '';
    // The mount path is a dep in its own right: bootstrap's compact project has
    // none, and the full row is later merged into the SAME instance, so a
    // reference-only `project` dep would keep the workspace fallback forever.
  }, [workdir, project, project?.fs_storage_mount_path, workspacePath]);

  const openProjectFolder = useCallback(async () => {
    if (!computeNode?.typeId || !projectPath) return;
    try {
      await fsManager.open(computeNode.typeId, projectPath.replace(/^\//, ''));
    } catch (error) {
      console.error('[ProjectLocation] Failed to open folder:', error);
    }
  }, [computeNode?.typeId, projectPath]);

  return { project, computeNode, projectPath, openProjectFolder };
}
