import { AgenticProcess, type APIEntity, type ProcessIconKey, type AnyEntity } from '@sdk';
import { pickProcessIcon } from '@src/components/icons/process-icons';
import type { IconComp } from './IconWithBadge';

/** Per-entity-type sub-icon selector: instance state → a small badge glyph (or null). */
type SubIconSelector = (entity: AnyEntity) => IconComp | null;

/**
 * Registry of per-instance sub-icon selectors, keyed by entity type. Mirrors the
 * per-TYPE `iconForType` registry, but each selector reads an entity INSTANCE's
 * runtime state. Add an entry here to give a type an instance-derived corner badge.
 */
const SUB_ICON_SELECTORS: Record<string, SubIconSelector> = {
  [AgenticProcess.type]: (entity) => {
    const proc = entity as AgenticProcess;
    // Reuse the SDK-owned worker_type→vendor mapping (`AgenticProcess.processIconKey`), but
    // drop the `-restore` state axis: the *-restore glyphs are themselves composite
    // (a badge inside a badge), and this sub-icon only conveys the vendor.
    const key = proc.processIconKey.replace('-restore', '') as ProcessIconKey;
    return pickProcessIcon(key);
  },
};

/**
 * Resolve the per-INSTANCE sub-icon (corner badge) for an entity, or null when
 * the type has no selector or the instance is missing. Instance-driven analogue
 * of `iconForType` (which is per-TYPE): the base icon stays type-driven, this only
 * adds the badge, and only where a real entity instance is available (many call
 * sites have just a type string → no sub-icon, base-only).
 */
export function subIconForEntity(entity: AnyEntity | null | undefined): IconComp | null {
  if (!entity) return null;
  const selector = SUB_ICON_SELECTORS[entity.getType()];
  return selector ? selector(entity) : null;
}
