import { useEffect, useMemo, useState } from 'react';
import { apiClient } from '@sdk/client';
import { dataManager } from '@sdk';
import { isBrowseableIn, type ViewMode } from '@sdk/FlowSync/schema';
import { useViewMode } from '@src/contexts/view-mode-context';

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
  browseable_by: ViewMode | null;
  /** Folder-layout type whose asset_ref is the bare folder (e.g. skill): its
   *  sidebar row expands into the on-disk file tree. Sourced from
   *  ``/assets/types`` (``folder_backed``), like vaults. */
  folder_backed?: boolean;
  vaults?: AssetTypeVault[];
}

/** Title-case a snake_case type name: "claude_memory" -> "Claude Memory". */
function humanize(typeName: string): string {
  return typeName
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Static asset-type metadata sourced from the frontend SchemaRegistry,
 *  filtered to types browseable in the current view ``mode`` (cumulative).
 *  Guarded so it degrades to [] if the registry isn't ready yet (e.g. a
 *  component test that mounts before bootstrap/loadTypes ran). */
function staticAssetTypes(mode: ViewMode): AssetTypeInfo[] {
  return (dataManager?.getAllTypeInfos?.() ?? [])
    .filter((t) => isBrowseableIn(t.browseable_by, mode))
    .map((t) => ({
      type_name: t.type_name,
      label: humanize(t.type_name),
      icon: t.icon,
      creatable: t.creatable,
      browseable_by: t.browseable_by,
      // Sourced synchronously from the registry like every other static field —
      // available on the first render, so a deep-link auto-expand can't race it.
      folder_backed: t.folder_backed,
    }));
}

/**
 * Asset-type catalog for the asset browser.
 *
 * Static metadata (type_name/label/icon/creatable/browseable_by) comes from the
 * frontend SchemaRegistry — no per-type fetch — and is filtered by the current
 * view mode, so toggling the footer pill live-updates the catalog. The only
 * runtime piece is markdown ``vaults`` (per-project doc roots): we still fetch
 * ``/assets/types`` but consume ONLY its vaults, merging them onto markdown.
 */
export function useAssetTypes(): { types: AssetTypeInfo[]; isLoading: boolean } {
  const mode = useViewMode();
  const [vaults, setVaults] = useState<AssetTypeVault[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<{ types: AssetTypeInfo[] }>('/assets/types')
      .then((res) => {
        if (cancelled) return;
        setVaults(res?.types?.find((t) => t.type_name === 'markdown')?.vaults || []);
        setIsLoading(false);
      })
      .catch(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-derive the catalog whenever the view mode changes (live filtering) or the
  // runtime markdown vaults arrive; merge the vaults onto the markdown entry.
  // folder_backed is already on each entry (sync, from the registry).
  const types = useMemo(
    () =>
      staticAssetTypes(mode).map((t) =>
        t.type_name === 'markdown' ? { ...t, vaults } : t,
      ),
    [mode, vaults],
  );

  return { types, isLoading };
}
