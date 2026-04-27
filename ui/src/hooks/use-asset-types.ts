import { useEffect, useState } from 'react';
import apiClient from '@sdk/client';

export interface AssetTypeVault {
  /** Entity typeid in VFS form, e.g. "compute_node-@local" or "project-<uuid>". */
  typeid: string;
  /** Path relative to the typeid. Empty string for the entity root itself. */
  relPath: string;
  /** Human-readable label for the vault (e.g. "User docs", "Project docs (foo)"). */
  label: string;
  /** Absolute filesystem path corresponding to (typeid, relPath). Primarily used
   *  for the parent_path filter when drilling into a folder. */
  absPath: string;
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
