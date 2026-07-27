import { useMemo } from 'react';
import { Project, TypeId, type ProjectContextDirInfo } from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks';
import { useProjectContextFolders } from '@src/hooks/use-project-context-folders';
import { useExplorerComputeNode } from '@src/components/explorer-view/useExplorerComputeNode';
import { basename, normalizeRel } from '@src/components/browseable-tree/adapters/fsFolderRoot';

/** The context folder a browsed path belongs to, resolved for its consumers. */
export interface ContextFolderTarget {
  /** The linked Folder entity's typeid; null when the directory has no entity
   *  yet (a legacy dir, or one the user is merely browsing). */
  typeid: string | null;
  /** Origin kind stamped at link time ("git" | "local"), or null when the
   *  directory isn't a linked context folder and nothing has resolved it.
   *  null means UNKNOWN, not "not a repo" — only the preflight is authoritative
   *  about git-ness. */
  originKind: string | null;
  /** The folder's repo root as a compute-node-absolute path (git-ops workdir). */
  workdir: string;
  /** The folder's own basename — what an action about it should be labelled with. */
  name: string;
  /** Compute node backing the VFS/git-ops for this folder. */
  computeNodeId: string;
}

/**
 * The context folder CONTAINING `relPath` — the deepest thing that actually has
 * an identity. A pointer addresses any depth (`repo/docs/api`), but only the
 * context dir itself is linked as a `Folder` entity and only its root is a repo,
 * so both the entity and the git workdir belong to the container, never to the
 * browsed leaf.
 *
 * Returns every containing folder, git-backed or not — a caller offering "set up
 * git" needs to see the non-git ones. Filter on `originKind` if you only want
 * repos.
 */
export function useContextFolderForRel(
  projectId: string | null | undefined,
  relPath: string,
): ContextFolderTarget | null {
  const { typeId: computeTypeId } = useExplorerComputeNode();
  const projectTypeId = useMemo(() => (projectId ? new TypeId(Project.type, projectId) : null), [projectId]);
  const { data: project } = useEntity<Project>(projectTypeId, { watch: true, enabled: !!projectTypeId });
  const { contextDirInfos } = useProjectContextFolders(project);

  const rel = normalizeRel(relPath);
  const match = useMemo(() => matchContextDir(contextDirInfos, rel), [contextDirInfos, rel]);

  const computeNodeId = computeTypeId?.id ?? '@local';
  return useMemo(() => {
    // A registered context folder resolves to its ROOT (not the browsed leaf):
    // that's the repo, and the only part with an identity. Otherwise the user is
    // browsing the project's own tree — still a real directory worth sharing, it
    // just has no Folder entity yet, so the caller mints one on demand (Folder
    // ids are deterministic, so minting is get-or-create).
    const dirRel = match ? normalizeRel(match.path) : rel;
    if (!dirRel) return null;
    return {
      typeid: match?.typeid || null,
      originKind: match?.origin_kind ?? null,
      workdir: `/${dirRel}`,
      name: basename(dirRel) || dirRel,
      computeNodeId,
    };
  }, [match, rel, computeNodeId]);
}

/**
 * The containment match, split out from the hook so it tests as plain data.
 * `rel` must already be normalized. A path matches its own context dir and any
 * descendant of it; the deepest dir wins when they nest.
 */
export function matchContextDir(
  infos: readonly ProjectContextDirInfo[],
  rel: string,
): ProjectContextDirInfo | null {
  let best: ProjectContextDirInfo | null = null;
  let bestLen = -1;
  for (const info of infos) {
    const dirRel = normalizeRel(info.path);
    if (!dirRel) continue;
    if (rel !== dirRel && !rel.startsWith(`${dirRel}/`)) continue;
    if (dirRel.length > bestLen) {
      best = info;
      bestLen = dirRel.length;
    }
  }
  return best;
}
