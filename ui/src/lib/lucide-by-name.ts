import * as lucideIcons from 'lucide-react';
import { File, type LucideIcon } from 'lucide-react';

/**
 * Resolve a `lucide-react` icon component by its export name.
 *
 * Used to match the `icon` field returned by `GET /api/v1/assets/types`
 * (declared per-record-type as `_icon: ClassVar[str]`) to a runtime
 * component. Returns `File` when the name doesn't resolve.
 */
export function lucideByName(iconName: string | null | undefined): LucideIcon {
  if (!iconName) return File;
  const exports = lucideIcons as unknown as Record<string, unknown>;
  const candidate = exports[iconName];
  return (candidate ?? File) as LucideIcon;
}
