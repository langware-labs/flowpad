import { useEffect, useState } from 'react';
import apiClient from '@sdk/client';

export interface AssetTypeInfo {
  type_name: string;
  label: string;
  icon: string | null;
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
