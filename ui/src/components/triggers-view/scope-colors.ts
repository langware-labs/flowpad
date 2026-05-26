/** Shared scope chip colors + labels used by every triggers-view surface.
 *
 * Three consumers used to keep their own copy of this map
 * (TriggerListItem, TriggerEditor, ScheduleTriggerEditor, FsopTriggerDetail).
 * Centralising here avoids drift — adding a new scope (e.g. "team") is now
 * one edit, not four.
 */
export const SCOPE_COLORS: Record<string, string> = {
  system: 'bg-muted text-muted-foreground',
  user: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  project: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
};

export const SCOPE_LABELS: Record<string, string> = {
  system: 'System',
  user: 'User',
  project: 'Project',
};

/** Lookup with safe fallback to the 'user' palette. */
export function scopeColor(scope: string | null | undefined): string {
  return SCOPE_COLORS[scope || 'user'] ?? SCOPE_COLORS['user'];
}
