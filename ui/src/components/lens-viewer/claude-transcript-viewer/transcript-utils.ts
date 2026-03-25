import type { TranscriptEntry } from '@sdk';

/**
 * Format number with K/M suffix
 */
export function formatNumber(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toLocaleString();
}

/**
 * Relative time string (e.g. "5m ago", "2h ago")
 */
export function formatAgo(isoTs: string): string {
  const diffMs = Date.now() - new Date(isoTs).getTime();
  if (diffMs < 60_000) return 'just now';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Format duration in ms to human readable
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

export function resolveEntryTimestamp(entry: TranscriptEntry): string | null {
  const raw = (entry as { raw?: { timestamp?: string; snapshot?: { timestamp?: string } } }).raw;
  const fromRaw = raw?.snapshot?.timestamp || raw?.timestamp;
  return entry.timestamp || fromRaw || null;
}

export function formatEntryTime(entry: TranscriptEntry): string {
  const value = resolveEntryTimestamp(entry);
  if (!value) return '--:--';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '--:--' : date.toLocaleTimeString();
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
