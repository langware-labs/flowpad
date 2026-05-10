/**
 * Worker-agnostic transcript utilities — operate on `UnifiedEntry`.
 */

import type { ComponentType } from 'react';
import type { ProcessIconKey } from '@sdk';

import { pickProcessIcon } from '../../../icons/process-icons';
import type { UnifiedEntry } from './types';

export { formatNumber, formatAgo, formatDuration, formatTime } from '../format-utils';
import { formatTime } from '../format-utils';

/** Display label for a worker key (`claude`, `codex`, …). */
export function workerLabel(worker: string | undefined): string {
  if (!worker) return 'Assistant';
  const key = worker.toLowerCase();
  if (key.startsWith('claude')) return 'Claude';
  if (key.startsWith('codex')) return 'Codex';
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
    return 'generic';
  })();
  return pickProcessIcon(key);
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
