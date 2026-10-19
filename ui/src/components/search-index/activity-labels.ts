import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { IndexProgressTable, SystemActivity, TypeProgressRow } from '@sdk';

// Held as lazy `msg` descriptors and resolved through `i18n._` at call time, so
// the words follow a locale switch instead of binding the language at import.
type PhaseLabel = { bare: MessageDescriptor; trailing: MessageDescriptor; showCounts: boolean };

const PHASE_LABELS: Record<SystemActivity, PhaseLabel> = {
  archive: { bare: msg`Archiving`, trailing: msg`Archiving…`, showCounts: false },
  clear: { bare: msg`Clearing index`, trailing: msg`Clearing index…`, showCounts: false },
  load_from_archive: { bare: msg`Restoring`, trailing: msg`Restoring…`, showCounts: false },
  scan: { bare: msg`Scanning`, trailing: msg`Scanning`, showCounts: true },
  index: { bare: msg`Indexing`, trailing: msg`Indexing`, showCounts: true },
};

// job_name arrives over the wire as a string; an unrecognised value must never
// crash the whole app via the footer pill — degrade to a generic label instead.
const FALLBACK_LABEL: PhaseLabel = { bare: msg`Working`, trailing: msg`Working`, showCounts: true };

function labelFor(activity: SystemActivity): PhaseLabel {
  return (PHASE_LABELS as Record<string, PhaseLabel>)[activity] ?? FALLBACK_LABEL;
}

export function phaseLabel(activity: SystemActivity): string {
  return i18n._(labelFor(activity).bare);
}

export function phaseLabelTrailing(activity: SystemActivity): string {
  return i18n._(labelFor(activity).trailing);
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
function phaseSource(activity: SystemActivity, table: IndexProgressTable | null): SystemActivity {
  return (table?.job_name as SystemActivity) ?? activity;
}

export function activityHeaderTitle(activity: SystemActivity, table: IndexProgressTable | null): string {
  const { trailing: descriptor, showCounts } = labelFor(phaseSource(activity, table));
  const trailing = i18n._(descriptor);
  if (!showCounts) return trailing;
  const counts = progressCountsLabel(table);
  return counts ? `${trailing}… ${counts}` : `${trailing}…`;
}

export function activityFooterLabel(activity: SystemActivity, table: IndexProgressTable | null): string {
  const phase = i18n._(labelFor(phaseSource(activity, table)).bare);
  if (!table) return phase;
  const current = table.current ?? '…';
  if (table.total > 0) {
    const pct = Math.round((table.done / table.total) * 100);
    return `${phase} ${table.done}/${table.total} (${pct}%) · ${current}`;
  }
  return `${phase} ${table.done} · ${current}`;
}

export function rowState(row: TypeProgressRow, current: string | null): 'done' | 'current' | 'pending' {
  if (current === row.type_name) return 'current';
  if (row.total > 0 && row.done >= row.total) return 'done';
  return 'pending';
}
