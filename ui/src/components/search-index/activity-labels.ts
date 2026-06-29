import type { IndexProgressTable, SystemActivity, TypeProgressRow } from '@sdk';

type PhaseLabel = { bare: string; trailing: string; showCounts: boolean };

const PHASE_LABELS: Record<SystemActivity, PhaseLabel> = {
  archive: { bare: 'Archiving', trailing: 'Archiving…', showCounts: false },
  clear: { bare: 'Clearing index', trailing: 'Clearing index…', showCounts: false },
  load_from_archive: { bare: 'Restoring', trailing: 'Restoring…', showCounts: false },
  scan: { bare: 'Scanning', trailing: 'Scanning', showCounts: true },
  index: { bare: 'Indexing', trailing: 'Indexing', showCounts: true },
};

// job_name arrives over the wire as a string; an unrecognised value must never
// crash the whole app via the footer pill — degrade to a generic label instead.
const FALLBACK_LABEL: PhaseLabel = { bare: 'Working', trailing: 'Working', showCounts: true };

function labelFor(activity: SystemActivity): PhaseLabel {
  return (PHASE_LABELS as Record<string, PhaseLabel>)[activity] ?? FALLBACK_LABEL;
}

export function phaseLabel(activity: SystemActivity): string {
  return labelFor(activity).bare;
}

export function phaseLabelTrailing(activity: SystemActivity): string {
  return labelFor(activity).trailing;
}

export function progressCountsLabel(table: IndexProgressTable | null): string | null {
  if (!table) return null;
  if (table.total > 0) return `${table.done.toLocaleString()}/${table.total.toLocaleString()}`;
  return table.done.toLocaleString();
}

// The index activity runs discovery (job_name "scan") then the per-record
// loop (job_name "index") under one SystemActivity ("index"). Prefer the live
// table's job_name for the phase word so the label tracks the real sub-phase
// ("Scanning" → "Indexing") instead of freezing on the activity name.
function phaseSource(
  activity: SystemActivity,
  table: IndexProgressTable | null,
): SystemActivity {
  return (table?.job_name as SystemActivity) ?? activity;
}

export function activityHeaderTitle(
  activity: SystemActivity,
  table: IndexProgressTable | null,
): string {
  const { trailing, showCounts } = labelFor(phaseSource(activity, table));
  if (!showCounts) return trailing;
  const counts = progressCountsLabel(table);
  return counts ? `${trailing}… ${counts}` : `${trailing}…`;
}

export function activityFooterLabel(
  activity: SystemActivity,
  table: IndexProgressTable | null,
): string {
  const phase = labelFor(phaseSource(activity, table)).bare;
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
