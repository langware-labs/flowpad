import { dataManager, isTypeId, TypeId } from '@sdk';
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
  if (!isTypeId(typeid)) return typeid;
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

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}
