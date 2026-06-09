import * as lucideIcons from 'lucide-react';
import { FileText, type LucideIcon } from 'lucide-react';

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
  const exports = lucideIcons as unknown as Record<string, unknown>;
  const candidate = exports[iconName];
  return (candidate ?? FileText) as LucideIcon;
}
