import { FSEntry, Project, QueryRequest } from '@sdk';
import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { DirectoryTree } from './DirectoryTree';
import type { DirectoryTreeProps } from './types';

/**
 * Props for ProjectsDirectoryTree
 * Extends DirectoryTreeProps but excludes rootFolders since we provide them automatically
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ProjectsDirectoryTreeProps extends Omit<DirectoryTreeProps, 'rootFolders'> {}

/**
 * ProjectsDirectoryTree - Wrapper that automatically uses all user projects as roots
 *
 * This component queries all user projects and displays them as independent roots
 * in a unified directory tree view. Each project becomes an expandable root folder.
 *
 * Usage:
 * ```tsx
 * <ProjectsDirectoryTree
 *   selectedPath={selectedPath}
 *   onSelect={handleSelect}
 * />
 * ```
 */
export function ProjectsDirectoryTree(props: ProjectsDirectoryTreeProps) {
  const { t } = useLingui();
  const [rootFolders, setRootFolders] = useState<FSEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadProjects();
  }, []);

  const loadProjects = async () => {
    try {
      setLoading(true);
      setError(null);

      const projects = await Project.query(
        new QueryRequest({
          type: 'project',
          query: { expand: ['permissions'] },
          name: 'Load projects for directory tree',
        }),
      );

      const roots: FSEntry[] = projects.map(
        (project) =>
          new FSEntry({
            vfs_abs_path: `${project.typeId.type}-${project.typeId.id}/.`,
            is_dir: true,
            size: 0,
          }),
      );

      setRootFolders(roots);
    } catch (err) {
      console.error('Failed to load projects:', err);
      setError(err instanceof Error ? err.message : t`Failed to load projects`);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <div className="p-4 text-center text-xs text-muted-foreground"><Trans>Loading projects...</Trans></div>;
  }

  if (error) {
    return <div className="p-4 text-center text-xs text-destructive">{error}</div>;
  }

  return <DirectoryTree {...props} rootFolders={rootFolders} />;
}
