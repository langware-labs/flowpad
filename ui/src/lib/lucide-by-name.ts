import * as lucideIcons from 'lucide-react';
import { FileText, type LucideIcon } from 'lucide-react';
import { WikiIcon } from '@src/components/icons/WikiIcon';

/**
 * Custom (non-lucide) icon components addressable by the same string name that
 * the backend type registry publishes in `TypeInfo.icon`. Lets a type opt into
 * a bespoke glyph (e.g. the wiki "W") while keeping the backend as the single
 * source of truth for which icon a type uses. Consulted before lucide.
 */
const CUSTOM_ICONS: Record<string, LucideIcon> = {
  WikiW: WikiIcon as unknown as LucideIcon,
};

/**
 * Resolve a `lucide-react` icon component by its export name.
 *
 * Used to match the `icon` field returned by `GET /api/v1/assets/types`
 * (declared per-record-type as `_icon: ClassVar[str]`) to a runtime
 * component. Returns `FileText` when the name doesn't resolve — the same
 * generic glyph `iconForType()` falls back to, so a missing-icon type and a
 * typo'd-icon type render identically (previously this returned `File` while
 * iconForType returned `FileText`, giving two different "unknown" glyphs).
 */
export function lucideByName(iconName: string | null | undefined): LucideIcon {
  if (!iconName) return FileText;
  const custom = CUSTOM_ICONS[iconName];
  if (custom) return custom;
  const exports = lucideIcons as unknown as Record<string, unknown>;
  const candidate = exports[iconName];
  return (candidate ?? FileText) as LucideIcon;
}
