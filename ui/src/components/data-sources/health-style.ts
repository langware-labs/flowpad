/**
 * How a source's health looks, in one table.
 *
 * Its own module because it is neither a provider nor a form field, and
 * `provider-catalog` announces itself as those.
 */
import { msg } from '@lingui/core/macro';
import type { SourceHealth } from '@sdk';
import { type SourceLook } from './source-look';

/**
 * Health → everything the status line says about it. Mirrors `SourceHealth`
 * (flow_sdk/ingest/health.py); `config_error` reads as "needs attention"
 * because that is what it means operationally: the scheduler has parked it.
 *
 * One table rather than three parallel ones — keyed by the `SourceHealth` union
 * so adding a state is a type error here instead of a silently unstyled line.
 */
export const HEALTH_STYLE: Record<SourceHealth, SourceLook> = {
  ok: {
    label: msg`Running`,
    dot: 'bg-emerald-500',
    text: 'text-emerald-600 dark:text-emerald-400',
    border: 'border-s-emerald-500/60',
  },
  never_synced: {
    label: msg`Never synced`,
    dot: 'bg-muted-foreground/50',
    text: 'text-muted-foreground',
    border: 'border-s-border',
  },
  transient_error: {
    label: msg`Retrying`,
    dot: 'bg-amber-500',
    text: 'text-amber-600 dark:text-amber-400',
    border: 'border-s-amber-500/70',
  },
  config_error: {
    label: msg`Needs attention`,
    // Red is the dot and the row's border, never the words: red text on a dark
    // theme does not read (the error rule — tinted row, red border).
    dot: 'bg-red-500',
    text: 'text-foreground',
    border: 'border-s-red-500/70',
  },
};

/** The style row for a health value, tolerating one the backend added first. */
export function healthStyle(health: string | undefined): SourceLook {
  return HEALTH_STYLE[(health || 'never_synced') as SourceHealth] ?? HEALTH_STYLE.never_synced;
}
