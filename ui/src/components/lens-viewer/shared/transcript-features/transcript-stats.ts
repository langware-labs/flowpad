import type { UnifiedEntry } from './types';

export interface TranscriptStatsSummary {
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  totalEntries: number;
  uniqueTools: number;
  duration: number | null;
  models: string[];
  toolCounts: Record<string, number>;
}

/**
 * Compute aggregate counts from a list of unified entries. Works for any
 * worker — relies only on the unified shape.
 *
 * `toolCounts` keys are SEMANTIC kinds (`file_write`, `shell_command`, …)
 * for recognized operations, falling back to the raw `tool_name` for
 * catch-all `tool_use` rows. This keeps the filter chips uniform across
 * workers — claude `Bash` and codex `exec_command` both count as
 * `shell_command`.
 */
export function computeStats(entries: UnifiedEntry[]): TranscriptStatsSummary {
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  const toolCounts: Record<string, number> = {};
  const models = new Set<string>();
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  for (const e of entries) {
    if (e.role === 'user' && (e.text?.trim().length ?? 0) > 0) userMessages++;
    if (e.role === 'assistant') {
      if (e.text?.trim().length || e.thinking?.trim().length) assistantMessages++;
    }
    if (e.role === 'operation' && e.operation) {
      toolCalls++;
      const op = e.operation;
      // Catch-all `tool_use` keeps the raw tool name so MCP / unknown tools
      // surface individually. Semantic kinds collapse onto their kind.
      const key = op.kind === 'tool_use'
        ? (op as { tool_name: string }).tool_name || 'tool_use'
        : op.kind;
      toolCounts[key] = (toolCounts[key] || 0) + 1;
    }
    if (e.timestamp) {
      const ms = new Date(e.timestamp).getTime();
      if (Number.isFinite(ms)) {
        if (firstTs == null || ms < firstTs) firstTs = ms;
        if (lastTs == null || ms > lastTs) lastTs = ms;
      }
    }
  }

  const duration = firstTs != null && lastTs != null && lastTs > firstTs ? lastTs - firstTs : null;
  return {
    userMessages,
    assistantMessages,
    toolCalls,
    totalEntries: entries.length,
    uniqueTools: Object.keys(toolCounts).length,
    duration,
    models: Array.from(models),
    toolCounts,
  };
}
