/**
 * Worker-agnostic transcript utilities — operate on `UnifiedEntry`.
 */

import type { ComponentType } from 'react';
import type { GenericEntry, ProcessIconKey } from '@sdk';
import { isToolUse } from '@sdk';
import type { WorkerType } from '@src/hooks/use-transcript';

import { processIconTag } from '@sdk';
import { flowIconComponent } from '@sdk/react/FlowIcon';
import type { UnifiedEntry } from './types';

export { formatNumber, formatAgo, formatDuration, formatTime } from '../format-utils';
import { formatTime } from '../format-utils';

/**
 * Worker ↔ session entity-type, the one map for that direction (mirrors the
 * backend `SESSION_TYPE_BY_WORKER`). `workerForSessionType` is what lets any
 * surface holding only a record type — a search row, a staged attachment —
 * address the worker-generic transcript route.
 *
 * Only these three vendors have a session ENTITY type. OpenCode deliberately has
 * none (its sessions live in SQLite, so the filesystem indexer has nothing to
 * mint one from — see the backend `SESSION_TYPE_BY_WORKER`, which has no
 * opencode row either).
 *
 * Typed `Partial<Record<WorkerType, …>>` so indexing it with a bare `WorkerType`
 * yields `string | undefined` — callers must HANDLE the miss rather than
 * interpolate it into a key string (`"undefined/ses_…"`).
 *
 * Note this uses the transcript-lens `WorkerType` (`claude`), NOT the launcher
 * one (`claude_code`). The codebase carries several incompatible spellings of
 * "which vendor"; picking the wrong one here silently yields undefined for
 * every row.
 */
export const SESSION_TYPE_BY_WORKER: Partial<Record<WorkerType, string>> = {
  claude: 'claude_session',
  codex: 'codex_session',
  copilot: 'copilot_session',
};

const WORKER_BY_SESSION_TYPE: Record<string, 'claude' | 'codex' | 'copilot'> = Object.fromEntries(
  Object.entries(SESSION_TYPE_BY_WORKER).map(([worker, type]) => [type, worker]),
) as Record<string, 'claude' | 'codex' | 'copilot'>;

/** The worker whose transcripts this record type holds, or undefined when the
 *  type isn't a worker session at all. */
export function workerForSessionType(type: string | null | undefined): 'claude' | 'codex' | 'copilot' | undefined {
  return type ? WORKER_BY_SESSION_TYPE[type] : undefined;
}

/** Display label for a worker key (`claude`, `codex`, …). */
export function workerLabel(worker: string | undefined): string {
  if (!worker) return 'Assistant';
  const key = worker.toLowerCase();
  if (key.startsWith('claude')) return 'Claude';
  if (key.startsWith('codex')) return 'Codex';
  if (key.startsWith('copilot')) return 'Copilot';
  if (key.startsWith('workflow')) return 'Workflow';
  // Capitalize unknown worker keys for a sensible default.
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** Resolve the worker logo SVG component from a raw worker key. */
export function workerIcon(worker: string | undefined): ComponentType<{ className?: string }> {
  const key: ProcessIconKey = ((): ProcessIconKey => {
    if (!worker) return 'generic';
    const w = worker.toLowerCase();
    if (w.startsWith('claude')) return 'claude';
    if (w.startsWith('codex')) return 'codex';
    if (w.startsWith('copilot')) return 'copilot';
    if (w.startsWith('opencode')) return 'opencode';
    return 'generic';
  })();
  return flowIconComponent(processIconTag(key));
}

export function resolveEntryTimestamp(entry: UnifiedEntry): string | null {
  return entry.timestamp || null;
}

export function formatEntryTime(entry: UnifiedEntry): string {
  return formatTime(resolveEntryTimestamp(entry));
}

/** Pluck the assistant turn's body text (no tool calls). */
export function getEntryText(entry: UnifiedEntry): string {
  return entry.text ?? '';
}

/** True iff the user turn has any visible text body (not just tool_result). */
export function hasUserText(entry: UnifiedEntry): boolean {
  return entry.role === 'user' && !!(entry.text && entry.text.trim().length);
}

/**
 * Filter-chip key for an operation. Catch-all `tool_use` rows surface their
 * raw tool name so MCP / unknown tools each get their own chip; semantic
 * kinds (`shell_command`, `file_write`, …) collapse onto the kind.
 */
export function operationFilterKey(op: GenericEntry): string {
  if (isToolUse(op)) return op.tool_name || 'tool_use';
  return op.kind;
}

/**
 * One-line preview of a `thinking` block for the collapsed row. Strips the
 * leading `**header**\n\n` codex emits so the preview is the body of the
 * reasoning rather than the section title — and never shows the verbose
 * "[no plaintext reasoning summary…]" placeholder inline.
 */
export function thinkingPreview(thinking: string | null | undefined): string {
  if (!thinking) return '';
  if (thinking.startsWith('[')) return ''; // bracketed placeholder — leave row blank, badge already says "thinking"
  const stripped = thinking.replace(/^\*\*(.+?)\*\*\s*\n+/, '$1 — ');
  const firstNonEmpty = stripped.split('\n').find((l) => l.trim()) ?? '';
  return firstNonEmpty.trim();
}

/** Collect the deduped, ordered list of operation filter keys in `entries`. */
export function collectToolKeys(entries: UnifiedEntry[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of entries) {
    if (e.role !== 'operation' || !e.operation) continue;
    const k = operationFilterKey(e.operation);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}
