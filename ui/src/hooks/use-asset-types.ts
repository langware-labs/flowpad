import { useMemo } from 'react';
import { LazyAsset } from '@sdk/lazy';
import { useLazyAsset } from '@sdk/react/hooks/useLazyAsset';
import type { AssetTypeVault } from '@sdk/lazy/assets';
export type { AssetTypeVault } from '@sdk/lazy/assets';
const NO_VAULTS: AssetTypeVault[] = [];
import { dataManager } from '@sdk';
import { isBrowseableIn, type ViewMode } from '@sdk/FlowSync/schema';
import { useViewMode, ViewMode as UiViewMode } from '@src/contexts/view-mode-context';
import { translateTypeLabel } from '@src/i18n/type-labels';

export interface AssetTypeInfo {
  type_name: string;
  label: string;
  icon: string | null;
  creatable: boolean;
  browseable_by: ViewMode | null;
  /** Folder-layout type whose asset_ref is the bare folder (e.g. skill): its
   *  sidebar row expands into the on-disk file tree. Sourced synchronously from
   *  the registry (TypeInfo.folder_backed), so it's set on the first render. */
  folder_backed?: boolean;
  /** `'folder'` when the asset is a directory that can own nested assets, `'file'`
   *  otherwise. Distinct from `folder_backed`: an Agent is folder-LAYOUT (so it can
   *  own an Mcp) but not folder-BACKED (its asset_ref is the inner agent.md). */
  main_layout?: string | null;
  /** Fixed inner filename for folder-backed assets, e.g. SKILL.md. */
  main_file?: string | null;
  vaults?: AssetTypeVault[];
}

export interface UseAssetTypesOptions {
  /**
   * The Assets tab keeps its normal Standard catalog while the surrounding app
   * uses the Vibe skin. Other catalog consumers retain their existing view-mode
   * filtering unless they opt in explicitly.
   */
  vibeAsStandard?: boolean;
  /**
   * Fetch markdown ``vaults``. They are the ONLY runtime piece here — everything
   * else is synchronous from the registry — so a caller that never reads
   * ``vaults`` should pass false and skip the request entirely rather than issue
   * a `/assets/types` GET per mount for a payload it discards.
   */
  withVaults?: boolean;
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
      // Same two-step as `labelForType`: the registry picks the word, i18n picks
      // the language. Without it the asset browser's type rows stayed English on
      // a Hebrew screen even where the rest of the pane had translated.
      label: translateTypeLabel(t.type_name, humanize(t.type_name)),
      icon: t.icon,
      creatable: t.creatable,
      browseable_by: t.browseable_by,
      // Sourced synchronously from the registry like every other static field —
      // available on the first render, so a deep-link auto-expand can't race it.
      folder_backed: t.folder_backed,
      main_layout: t.main_layout,
      main_file: t.main_file,
    }));
}

/**
 * Asset-type catalog for the asset browser.
 *
 * Static metadata (type_name/label/icon/creatable/browseable_by) comes from the
 * frontend SchemaRegistry — no per-type fetch — and is filtered by the effective
 * catalog mode. Most callers follow the current view mode; Assets tabs opt to
 * retain the Standard catalog in Vibe so their tree structure stays navigable.
 * The only runtime piece is markdown ``vaults`` (per-project doc roots): we still
 * fetch ``/assets/types`` but consume ONLY its vaults, merging them onto markdown.
 */
export function useAssetTypes(options: UseAssetTypesOptions = {}): { types: AssetTypeInfo[]; isLoading: boolean; error: Error | null; reload: () => Promise<unknown> } {
  const currentMode = useViewMode();
  const mode: ViewMode = options.vibeAsStandard && currentMode === UiViewMode.Vibe ? 'standard' : currentMode;
  const withVaults = options.withVaults ?? true;
  const { data, isLoading, error, reload } = useLazyAsset(LazyAsset.AssetCatalog, undefined, {
    enabled: withVaults, priority: 'background',
  });
  const vaults = data?.types.find(t => t.type_name === 'markdown')?.vaults ?? NO_VAULTS;

  // Re-derive the catalog whenever the view mode changes (live filtering) or the
  // runtime markdown vaults arrive; merge the vaults onto the markdown entry.
  // folder_backed is already on each entry (sync, from the registry).
  const types = useMemo(
    () => staticAssetTypes(mode).map((t) => (t.type_name === 'markdown' ? { ...t, vaults } : t)),
    [mode, vaults],
  );

  return { types, isLoading, error, reload };
}
