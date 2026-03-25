import { ErrorStatus } from '@src/hooks/useClaudeErrorRecords';

const UNKNOWN_TIMESTAMP = 'unknown';

const STATUS_SLUG_MAP: { value: ErrorStatus | 'all'; slug: string; label: string }[] = [
  { value: 'all', slug: 'all', label: 'All' },
  { value: ErrorStatus.OPEN, slug: 'open', label: 'Open' },
  { value: ErrorStatus.IGNORED, slug: 'ignored', label: 'Ignored' },
  { value: ErrorStatus.IGNORED_UNTIL, slug: 'snoozed', label: 'Snoozed' },
  { value: ErrorStatus.TASK_CREATED, slug: 'tasked', label: 'Tasked' },
];

export function statusFilterFromSlug(slug: string): ErrorStatus | 'all' {
  return STATUS_SLUG_MAP.find((sf) => sf.slug === slug)?.value ?? ErrorStatus.OPEN;
}

export function slugFromStatusFilter(value: ErrorStatus | 'all'): string {
  return STATUS_SLUG_MAP.find((sf) => sf.value === value)?.slug ?? 'open';
}

export function parseTranscriptPath(jsonlPath: string): { projectEncodedName: string; sessionId: string } | null {
  const marker = '.claude/projects/';
  const idx = jsonlPath.indexOf(marker);
  if (idx < 0) return null;
  const remainder = jsonlPath.substring(idx + marker.length);
  const slashIdx = remainder.indexOf('/');
  if (slashIdx < 0) return null;
  return {
    projectEncodedName: remainder.substring(0, slashIdx),
    sessionId: remainder.substring(slashIdx + 1).replace('.jsonl', ''),
  };
}

export { UNKNOWN_TIMESTAMP, STATUS_SLUG_MAP };
