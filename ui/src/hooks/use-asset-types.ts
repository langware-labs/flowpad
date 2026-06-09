import { useEffect, useState } from 'react';
import { apiClient } from '@sdk/client';
import { dataManager } from '@sdk';

export interface AssetTypeVault {
  typeid: string;
  relPath: string;
  label: string;
  scope: string;
  project_id?: string | null;
  record_project_id?: string | null;
}

export interface AssetTypeInfo {
  type_name: string;
  label: string;
  icon: string | null;
  creatable: boolean;
  browseable: boolean;
  vaults?: AssetTypeVault[];
}

/** Title-case a snake_case type name: "claude_memory" -> "Claude Memory". */
function humanize(typeName: string): string {
  return typeName
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Static asset-type metadata sourced from the frontend SchemaRegistry.
 *  Guarded so it degrades to [] if the registry isn't ready yet (e.g. a
 *  component test that mounts before bootstrap/loadTypes ran). */
function staticAssetTypes(): AssetTypeInfo[] {
  return (dataManager?.getAllTypeInfos?.() ?? [])
    .filter((t) => t.browseable)
    .map((t) => ({
      type_name: t.type_name,
      label: humanize(t.type_name),
      icon: t.icon,
      creatable: t.creatable,
      browseable: t.browseable,
    }));
}

/**
 * Asset-type catalog for the asset browser.
 *
 * Static metadata (type_name/label/icon/creatable/browseable) comes from the
 * frontend SchemaRegistry — no per-type fetch. The only runtime piece is
 * markdown ``vaults`` (per-project doc roots): we still fetch ``/assets/types``
 * but consume ONLY its vaults, merging them onto the markdown entry.
 */
export function useAssetTypes(): { types: AssetTypeInfo[]; isLoading: boolean } {
  const [types, setTypes] = useState<AssetTypeInfo[]>(() => staticAssetTypes());
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // `types` is already seeded from staticAssetTypes() by the useState
    // initializer; the effect only fetches the runtime markdown vaults and
    // merges them onto that base (no second static recompute).
    apiClient
      .get<{ types: AssetTypeInfo[] }>('/assets/types')
      .then((res) => {
        if (cancelled) return;
        const vaults =
          (res?.types || []).find((t) => t.type_name === 'markdown')?.vaults || [];
        setTypes((prev) =>
          prev.map((t) => (t.type_name === 'markdown' ? { ...t, vaults } : t)),
        );
        setIsLoading(false);
      })
      .catch(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { types, isLoading };
}
