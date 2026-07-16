import { useMemo } from 'react';
import { dataContext, Project, Task, TypeId } from '@sdk';
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
/** Git-vs-loose split of a set of attachment paths. */
export interface ArtifactClassification {
  /** Git context folders (as their Folder-entity typeids) that the paths live
   *  in — these ride as chips (click-to-clone). */
  gitFolderTypeids: string[];
  /** Attachment paths OUTSIDE every git context folder — these travel as
   *  ordinary message file attachments, not as chips. */
  loosePaths: string[];
}

export function useTaskGitAttachmentFolders(task: Task | null | undefined): ArtifactClassification & {
  isGitPath: (path: string) => boolean;
  /** Classify an ARBITRARY artifacts array (not just this task's) against the
   *  same git context folders — used to fold a task's parent attachments into
   *  the same send payload. */
  classifyArtifacts: (artifacts: unknown[] | null | undefined) => ArtifactClassification;
} {
  // Tasks created from the TaskBar may carry no project_id — fall back to the
  // currently scoped project, whose context folders are what the task's
  // attachments were picked from. Without this, ZERO git dirs resolve and a
  // git context folder gets misclassified as a loose FILE attachment.
  const projectId = task?.project_id ?? dataContext.project?.id ?? null;
  const { data: project } = useEntity<Project>(projectId ? new TypeId(Project.type, projectId) : null);
  const { contextDirInfos } = useProjectContextFolders(project ?? null);

  return useMemo(() => {
    const gitDirs = contextDirInfos
      .filter((i) => i.origin_kind === 'git')
      .map((i) => ({ path: i.path.replace(/\/$/, ''), typeid: i.typeid }));

    const isGitPath = (path: string) => {
      const p = (path || '').replace(/\/$/, '');
      return gitDirs.some((g) => p === g.path || p.startsWith(g.path + '/'));
    };

    const classifyArtifacts = (artifacts: unknown[] | null | undefined): ArtifactClassification => {
      const typeids = new Set<string>();
      const loose = new Set<string>();
      for (const a of artifacts ?? []) {
        const raw = typeof a === 'string' ? a : ((a as { path?: string } | null)?.path ?? '');
        if (!raw) continue;
        const p = raw.replace(/\/$/, '');
        const dir = gitDirs.find((g) => p === g.path || p.startsWith(g.path + '/'));
        if (dir?.typeid) typeids.add(dir.typeid);
        else if (!dir) loose.add(p);
      }
      return { gitFolderTypeids: Array.from(typeids), loosePaths: Array.from(loose) };
    };

    return { ...classifyArtifacts(task?.artifacts as unknown[] | undefined), isGitPath, classifyArtifacts };
  }, [contextDirInfos, task?.artifacts]);
}
