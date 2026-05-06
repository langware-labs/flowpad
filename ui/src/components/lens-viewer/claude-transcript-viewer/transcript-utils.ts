import type { TranscriptEntry } from '@sdk';

// Generic formatters now live in ../shared/format-utils — re-exported here so
// existing imports in this folder keep working.
export { formatNumber, formatAgo, formatDuration } from '../shared/format-utils';
import { formatTime } from '../shared/format-utils';

export function resolveEntryTimestamp(entry: TranscriptEntry): string | null {
  const raw = (entry as { raw?: { timestamp?: string; snapshot?: { timestamp?: string } } }).raw;
  const fromRaw = raw?.snapshot?.timestamp || raw?.timestamp;
  return entry.timestamp || fromRaw || null;
}

export function formatEntryTime(entry: TranscriptEntry): string {
  return formatTime(resolveEntryTimestamp(entry));
}

/**
 * Get a short summary string for a tool block (collapsed view)
 */
export function getToolSummary(tool: { name: string; input: Record<string, unknown> }): string {
  const input = tool.input;
  if (!input) return tool.name;
  if (tool.name === 'TaskCreate' || tool.name === 'TaskUpdate') {
    const subject = input.subject as string | undefined;
    if (subject) return `${tool.name}: ${subject}`;
  }
  return tool.name;
}

/**
 * Extract unique file basenames from tool blocks for header display
 */
export function getToolFileSummary(toolBlocks: { name: string; input: Record<string, unknown> }[]): string[] {
  const files: string[] = [];
  for (const tool of toolBlocks) {
    const input = tool.input;
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
