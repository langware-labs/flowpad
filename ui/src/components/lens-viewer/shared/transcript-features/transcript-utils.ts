/**
 * Worker-agnostic transcript utilities — operate on `UnifiedEntry`.
 */

import type { UnifiedEntry } from './types';

export { formatNumber, formatAgo, formatDuration, formatTime } from '../format-utils';
import { formatTime } from '../format-utils';

export function resolveEntryTimestamp(entry: UnifiedEntry): string | null {
  return entry.timestamp || null;
}

export function formatEntryTime(entry: UnifiedEntry): string {
  return formatTime(resolveEntryTimestamp(entry));
}

/** Short summary for a tool call (collapsed view). Used by both modes. */
export function getToolSummary(tool: { name: string; input: unknown }): string {
  const input = tool.input as Record<string, unknown> | null | undefined;
  if (!input) return tool.name;
  if (tool.name === 'TaskCreate' || tool.name === 'TaskUpdate') {
    const subject = input.subject as string | undefined;
    if (subject) return `${tool.name}: ${subject}`;
  }
  return tool.name;
}

/** Extract unique file basenames from tool calls for header display. */
export function getToolFileSummary(toolUses: { name: string; input: unknown }[]): string[] {
  const files: string[] = [];
  for (const tool of toolUses) {
    const input = tool.input as Record<string, unknown> | null | undefined;
    if (!input) continue;
    const filePath = (input.file_path || input.notebook_path) as string | undefined;
    if (filePath && typeof filePath === 'string') {
      const basename = filePath.split('/').pop() || filePath;
      if (!files.includes(basename)) files.push(basename);
      continue;
    }
    const pattern = input.pattern as string | undefined;
    if (pattern && typeof pattern === 'string' && (tool.name === 'Glob' || tool.name === 'Grep')) {
      const short = pattern.length > 30 ? pattern.slice(0, 27) + '...' : pattern;
      if (!files.includes(short)) files.push(short);
    }
  }
  return files;
}

/** Pluck the assistant turn's body text (no tool calls). */
export function getEntryText(entry: UnifiedEntry): string {
  return entry.text ?? '';
}

/** True iff the user turn has any visible text body (not just tool_result). */
export function hasUserText(entry: UnifiedEntry): boolean {
  return entry.role === 'user' && !!(entry.text && entry.text.trim().length);
}
