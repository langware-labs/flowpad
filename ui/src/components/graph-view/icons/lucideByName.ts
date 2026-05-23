import * as lucideIcons from 'lucide-react';
import { File, type LucideIcon } from 'lucide-react';

export function lucideByName(iconName: string | null | undefined): LucideIcon {
  if (!iconName) return File;
  const exports = lucideIcons as unknown as Record<string, unknown>;
  const candidate = exports[iconName];
  return (candidate ?? File) as LucideIcon;
}
