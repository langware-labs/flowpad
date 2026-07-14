import { dataManager, isTypeId, isValidUUIDv4, TypeId } from '@sdk';
import type { LucideIcon } from 'lucide-react';
import { lucideByName } from '@src/lib/lucide-by-name';
import { ICON_BY_TYPE } from '@src/components/conversation/EntityChip';
import type { AssetTypeInfo } from '@src/hooks/use-asset-types';

/**
 * Resolve a descriptor's typeid string to the cached entity's `displayName`.
 * Falls back to the raw typeid when the entity isn't in cache or the typeid
 * isn't well-formed.
 */
export function displayLabelForTypeid(typeid: string): string {
  // Name-form pseudo-typeids (entity-less inline personas, `agent-<name>`)
  // aren't cache-resolvable — show the bare name, not the raw pair.
  if (!isTypeId(typeid)) return parseTypeid(typeid).id || typeid;
  try {
    const entity = dataManager.getByTypeIdFromCache(new TypeId(typeid));
    return entity?.displayName ?? typeid;
  } catch {
    return typeid;
  }
}

/**
 * Build a typeName → LucideIcon resolver from an AssetTypeInfo[] (typically
 * the result of `useAssetTypes`). Prefers the API-provided icon name; falls
 * back to the chat EntityChip icon registry when the API hasn't loaded yet.
 */
export function makeIconForType(
  assetTypes: AssetTypeInfo[],
): (typeName: string) => LucideIcon {
  return (typeName: string): LucideIcon => {
    const ti = assetTypes.find((t) => t.type_name === typeName);
    const fromApi = ti?.icon ? lucideByName(ti.icon) : null;
    if (fromApi) return fromApi;
    return ICON_BY_TYPE[typeName] ?? lucideByName(null);
  };
}

export function parseTypeid(typeid: string): { type: string; id: string } {
  const dash = typeid.indexOf('-');
  if (dash < 0) return { type: typeid, id: '' };
  return { type: typeid.slice(0, dash), id: typeid.slice(dash + 1) };
}

/**
 * Whether a descriptor's typeid points at a real backing entity that can be
 * opened in an editor/viewer. Entity ids are always UUID v4/v5 (policy), so
 * gate on that rather than the looser isTypeId grammar: an entity-less inline
 * persona carries a name-form pseudo-typeid (e.g. `agent-team.lead`) that
 * parses as well-formed but has nothing to open. Single source of truth for
 * the "click to open" affordance shared by the asset picker and manager rows.
 */
export function isOpenableTypeid(typeid: string): boolean {
  return isTypeId(typeid) && isValidUUIDv4(parseTypeid(typeid).id);
}

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/**
 * Canonicalize a filesystem/VFS path for comparison and basename extraction:
 * backslashes → `/`, collapse repeated `/`, drop a trailing `/`. Shared by the
 * asset-manager popover (its `dirname`/`descriptorKey`) and `improvableMainFile`
 * so the normalization can't drift between the two.
 */
export function normalizePath(path: string | null | undefined): string {
  return (path ?? '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

/** The subset of a type's TypeInfo that decides its improvable main file. */
export interface ImprovableTypeInfo {
  folder_backed?: boolean;
  main_file?: string | null;
}

/**
 * The main file the asset "Improve" flow would edit for a descriptor, or `null`
 * when it can't be resolved — in which case the wand must be HIDDEN rather than
 * shown-then-errored ("no main file metadata"). Single source of truth shared by
 * the row's `canImprove` gate and `resolveImproveTarget`, so the affordance is
 * offered iff improvement can actually run:
 *   - folder-backed type → its TypeInfo `main_file` (empty ⇒ not improvable)
 *   - flat type          → the path basename
 */
export function improvableMainFile(
  descriptor: { typeid: string; posix_path?: string | null },
  typeInfoByName: Map<string, ImprovableTypeInfo>,
): string | null {
  const assetPath = normalizePath(descriptor.posix_path);
  if (!assetPath) return null;
  const { type } = parseTypeid(descriptor.typeid);
  const ti = typeInfoByName.get(type);
  const file = ti?.folder_backed ? ti.main_file ?? '' : basename(assetPath);
  return file || null;
}
