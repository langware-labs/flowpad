import { useEffect, useState } from 'react';
import apiClient from '@sdk/client';

export interface AssetTypeVault {
  /** Entity typeid in VFS form, e.g. "compute_node-@local" or "project-<uuid>". */
  typeid: string;
  /** Path relative to the typeid. Empty string for the entity root itself. */
  relPath: string;
  /** Human-readable label: "User" for the user vault, the project name for
   *  project vaults, or the folder name for env-supplied dirs. */
  label: string;
  /** Absolute filesystem path corresponding to (typeid, relPath). Primarily used
   *  for the parent_path filter when drilling into a folder. */
  absPath: string;
  /** 'user' | 'project' | 'system' — same scope axis used by record filtering.
   *  Used by the markdown tree to drop vaults outside the active filter. */
  scope: string;
  /** Synthetic project_id (uuid5 of the project mount) for project vaults; null
   *  otherwise. Matches what indexed records under this vault carry. */
  project_id: string | null;
}

export interface AssetTypeInfo {
  type_name: string;
  label: string;
  icon: string | null;
  creatable?: boolean;
  /** Optional per-type list of vault roots used for folder-tree rendering.
   *  Populated for markdown; absent for asset types that stay flat. */
  vaults?: AssetTypeVault[];
}

interface UseAssetTypesResult {
  types: AssetTypeInfo[];
  isLoading: boolean;
}

export function useAssetTypes(): UseAssetTypesResult {
  const [types, setTypes] = useState<AssetTypeInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    apiClient
      .get('/assets/types')
      .then((data: unknown) => {
        if (cancelled) return;
        const d = data as { types?: AssetTypeInfo[] } | null;
        setTypes(d?.types ?? []);
        setIsLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setTypes([]);
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { types, isLoading };
}
