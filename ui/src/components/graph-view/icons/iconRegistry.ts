import { FileText, type LucideIcon } from 'lucide-react';
import { lucideByName } from '@src/lib/lucide-by-name';
import { humanizeType } from '@src/utils/humanize';
import { translateTypeLabel } from '@src/i18n/type-labels';
import { dataManager } from '@sdk';

/**
 * Resolve the icon component for an entity type.
 *
 * The icon is sourced exclusively from the backend type registry
 * (TypeInfo.icon), loaded into the frontend SchemaRegistry at bootstrap — no
 * hardcoded per-type map and no runtime fetch. It may be a lucide export name
 * OR a path to a file the backend serves; `lucideByName` resolves both to a
 * component, so a type can ship a bespoke glyph without any call site knowing.
 * Unknown / icon-less types fall back to a generic document glyph. Guarded so
 * it degrades gracefully if the registry isn't initialized yet (e.g. an
 * isolated unit test).
 */
export function iconForType(type: string): LucideIcon {
  const name = dataManager?.iconForType?.(type);
  return (name && lucideByName(name)) || FileText;
}

/**
 * Resolve the UX-friendly label for an entity type — the curated
 * `TypeInfo.display_name` from the backend registry, falling back to the generic
 * title-caser `humanizeType` when a type has no curated label. Mirror of
 * `iconForType`; the single place app code turns a type string into a word.
 *
 * The registry answers in English only, so the resolved label then goes through
 * `translateTypeLabel` — the registry still decides WHICH word (and its number:
 * "Skills" labels a section, "Task" names one thing), i18n only decides which
 * language it is said in. Being the single choke point is what makes that one
 * change reach every surface: breadcrumbs, the asset manager's group headings,
 * the context-folder tree, the hub's record lists.
 */
export function labelForType(type: string): string {
  return translateTypeLabel(type, dataManager?.displayNameForType?.(type) || humanizeType(type));
}
