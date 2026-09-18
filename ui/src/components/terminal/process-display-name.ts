import type { AgenticProcess } from '@sdk';

/**
 * Project the backend's resolved name. Provider metadata, first-prompt fallback
 * and legacy display names are reconciled server-side; callers truncate with CSS.
 */
export function resolveProcessDisplayName(process: AgenticProcess): string {
  return process.name?.trim() || 'Session';
}
