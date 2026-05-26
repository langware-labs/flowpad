import type { IndexProgressTable, SystemActivity, TypeProgressRow } from '@sdk';

const PHASE_LABELS: Record<
  SystemActivity,
  { bare: string; trailing: string; showCounts: boolean }
> = {
  archive: { bare: 'Archiving', trailing: 'Archiving…', showCounts: false },
  clear: { bare: 'Clearing index', trailing: 'Clearing index…', showCounts: false },
  load_from_archive: { bare: 'Restoring', trailing: 'Restoring…', showCounts: false },
  scan: { bare: 'Scanning', trailing: 'Scanning', showCounts: true },
  index: { bare: 'Indexing', trailing: 'Indexing', showCounts: true },
};

export function phaseLabel(activity: SystemActivity): string {
  return PHASE_LABELS[activity].bare;
}

export function phaseLabelTrailing(activity: SystemActivity): string {
  return PHASE_LABELS[activity].trailing;
}

export function progressCountsLabel(table: IndexProgressTable | null): string | null {
  if (!table) return null;
  if (table.total > 0) return `${table.done.toLocaleString()}/${table.total.toLocaleString()}`;
  return table.done.toLocaleString();
}

export function activityHeaderTitle(
  activity: SystemActivity,
  table: IndexProgressTable | null,
): string {
  const { trailing, showCounts } = PHASE_LABELS[activity];
  if (!showCounts) return trailing;
  const counts = progressCountsLabel(table);
  return counts ? `${trailing}… ${counts}` : `${trailing}…`;
}

export function activityFooterLabel(
  activity: SystemActivity,
  table: IndexProgressTable | null,
): string {
  const phase = PHASE_LABELS[activity].bare;
  if (!table) return phase;
  const current = table.current ?? '…';
  if (table.total > 0) {
    const pct = Math.round((table.done / table.total) * 100);
    return `${phase} ${table.done}/${table.total} (${pct}%) · ${current}`;
  }
  return `${phase} ${table.done} · ${current}`;
}

export function rowState(
  row: TypeProgressRow,
  current: string | null,
): 'done' | 'current' | 'pending' {
  if (current === row.type_name) return 'current';
  if (row.total > 0 && row.done >= row.total) return 'done';
  return 'pending';
}
