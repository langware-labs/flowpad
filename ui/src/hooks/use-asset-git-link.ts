import { useMemo } from 'react';
import { dataManager, gitOriginRepoFullName, gitOriginWebUrl, type TypeId } from '@sdk';
import { useGitSharePreflight } from './use-git-share-preflight';

export interface AssetGitLink {
  /** Browsable provider URL for this asset, or null when there's nothing to link. */
  url: string | null;
  /** `owner/repo`, for the tooltip. Null whenever `url` is. */
  repoLabel: string | null;
}

const NO_LINK: AssetGitLink = { url: null, repoLabel: null };

/**
 * Where this asset lives on its Git provider — the "third location", alongside
 * cloud and local. Resolves through the backend-owned `git_share_preflight`
 * check (the entity's own `git_origin` field is only ever set on the RECEIVER of
 * a shared asset, so it would be null for anything authored here); an origin
 * comes back even when sharing is blocked by a dirty or unpushed tree, which is
 * correct — we are linking to the repo page, not sharing.
 *
 * `{url: null}` while loading, on failure, and whenever the asset isn't in a repo
 * with a browsable remote. Callers render nothing in that case.
 */
export function useAssetGitLink(ref: TypeId | null | undefined, enabled: boolean): AssetGitLink {
  const { origin } = useGitSharePreflight(ref ?? undefined, enabled);
  // Folder-layout types point at a directory in the repo, not a file. The flag is
  // backend-owned (TypeInfo.folder_backed) — never a hardcoded type list here.
  const isDir = !!(ref?.type && dataManager?.getTypeInfo?.(ref.type)?.folder_backed);

  return useMemo(() => {
    if (!origin) return NO_LINK;
    const url = gitOriginWebUrl(origin, { isDir });
    return url ? { url, repoLabel: gitOriginRepoFullName(origin) } : NO_LINK;
  }, [origin, isDir]);
}
