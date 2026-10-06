import { useMemo } from 'react';
import { Project, TypeId, type ProjectContextDirInfo } from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks';
import { useProjectDependencies } from '@src/hooks/use-project-dependencies';
import { useExplorerComputeNode } from '@src/components/explorer-view/useExplorerComputeNode';
import { basename, normalizeRel } from '@src/components/browseable-tree/adapters/fsFolderRoot';

/** The dependency folder a browsed path belongs to, resolved for its consumers. */
export interface DependencyFolderTarget {
  /** The linked Folder entity's typeid; null when the directory has no entity
   *  yet (a legacy dir, or one the user is merely browsing). */
  typeid: string | null;
  /** The `flow.json` dependency this folder resolves, or null when the path is
   *  in the project's own tree (or a legacy link with no dependency name). */
  dependency: string | null;
  /** False for an optional dependency; true otherwise (and for a non-dependency). */
  required: boolean;
  /** Origin kind stamped at link time ("git" | "local"), or null when the
   *  directory isn't a resolved dependency and nothing has resolved it.
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
 * The dependency folder CONTAINING `relPath` — the deepest thing that actually
 * has an identity. A pointer addresses any depth (`repo/docs/api`), but only the
 * dependency's folder is linked as a `Folder` entity and only its root is a repo,
 * so both the entity and the git workdir belong to the container, never to the
 * browsed leaf.
 *
 * Returns every containing folder, git-backed or not — a caller offering "set up
 * git" needs to see the non-git ones. Filter on `originKind` if you only want
 * repos.
 */
export function useDependencyForRel(
  projectId: string | null | undefined,
  relPath: string,
): DependencyFolderTarget | null {
  const { typeId: computeTypeId } = useExplorerComputeNode();
  const projectTypeId = useMemo(() => (projectId ? new TypeId(Project.type, projectId) : null), [projectId]);
  const { data: project } = useEntity<Project>(projectTypeId, { watch: true, enabled: !!projectTypeId });
  const { contextDirInfos } = useProjectDependencies(project, { fetchStates: false });

  const rel = normalizeRel(relPath);
  const match = useMemo(() => matchContextDir(contextDirInfos, rel), [contextDirInfos, rel]);

  const computeNodeId = computeTypeId?.id ?? '@local';
  return useMemo(() => {
    // A resolved dependency resolves to its ROOT (not the browsed leaf):
    // that's the repo, and the only part with an identity. Otherwise the user is
    // browsing the project's own tree — still a real directory worth sharing, it
    // just has no Folder entity yet, so the caller mints one on demand (Folder
    // ids are deterministic, so minting is get-or-create).
    const dirRel = match ? normalizeRel(match.path) : rel;
    if (!dirRel) return null;
    return {
      typeid: match?.typeid || null,
      dependency: match?.dependency || null,
      required: match?.required !== false,
      originKind: match?.origin_kind ?? null,
      workdir: `/${dirRel}`,
      name: basename(dirRel) || dirRel,
      computeNodeId,
    };
  }, [match, rel, computeNodeId]);
}

/**
 * The containment match, split out from the hook so it tests as plain data.
 * `rel` must already be normalized. A path matches its own dependency dir and any
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
