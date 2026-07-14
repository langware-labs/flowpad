import { useMemo } from 'react';
import { Project, Task, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { useProjectContextFolders } from '@src/hooks/use-project-context-folders';

/**
 * The git context folders referenced by a task's attachments.
 *
 * An attachment that is (or lives inside) one of the task's project git
 * context folders is represented by that Folder entity's typeid — the
 * assignment message attaches those as chips so recipients get the
 * click-to-clone flow (the folder rides origin-only via transferMode 'git').
 */
export function useTaskGitAttachmentFolders(task: Task | null | undefined): {
  gitFolderTypeids: string[];
  /** Attachment paths OUTSIDE every git context folder — these travel as
   *  ordinary message file attachments, not as chips. */
  loosePaths: string[];
  isGitPath: (path: string) => boolean;
} {
  const { data: project } = useEntity<Project>(task?.project_id ? new TypeId(Project.type, task.project_id) : null);
  const { contextDirInfos } = useProjectContextFolders(project ?? null);

  return useMemo(() => {
    const gitDirs = contextDirInfos
      .filter((i) => i.origin_kind === 'git')
      .map((i) => ({ path: i.path.replace(/\/$/, ''), typeid: i.typeid }));

    const isGitPath = (path: string) => {
      const p = (path || '').replace(/\/$/, '');
      return gitDirs.some((g) => p === g.path || p.startsWith(g.path + '/'));
    };

    const attachmentPaths: string[] = [];
    for (const a of (task?.artifacts as unknown[] | undefined) ?? []) {
      const path = typeof a === 'string' ? a : ((a as { path?: string } | null)?.path ?? '');
      if (path) attachmentPaths.push(path.replace(/\/$/, ''));
    }
    const typeids = new Set<string>();
    const loosePaths: string[] = [];
    for (const p of attachmentPaths) {
      const dir = gitDirs.find((g) => p === g.path || p.startsWith(g.path + '/'));
      if (dir?.typeid) typeids.add(dir.typeid);
      else if (!dir) loosePaths.push(p);
    }
    return { gitFolderTypeids: Array.from(typeids), loosePaths, isGitPath };
  }, [contextDirInfos, task?.artifacts]);
}
