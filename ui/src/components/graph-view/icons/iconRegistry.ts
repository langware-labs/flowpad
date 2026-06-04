import { FileText, type LucideIcon } from 'lucide-react';
import { lucideByName } from '@src/lib/lucide-by-name';
import { dataManager } from '@sdk';

/**
 * Resolve the lucide icon component for an entity type.
 *
 * The icon name is sourced exclusively from the backend type registry
 * (TypeInfo.icon), loaded into the frontend SchemaRegistry at bootstrap — no
 * hardcoded per-type map and no runtime fetch. Unknown / icon-less types fall
 * back to a generic document glyph. Guarded so it degrades gracefully if the
 * registry isn't initialized yet (e.g. an isolated unit test).
 */
export function iconForType(type: string): LucideIcon {
  const name = dataManager?.iconForType?.(type);
  return (name && lucideByName(name)) || FileText;
}
