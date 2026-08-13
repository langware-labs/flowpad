/**
 * How a source's health looks, in one table.
 *
 * Its own module because it is neither a provider nor a form field, and
 * `provider-catalog` announces itself as those. Shared by the card and the
 * stream rows, which is why it is not inline in either.
 */
import type { SourceHealth } from '@sdk';

/**
 * Health → everything the UI says about it. Mirrors `SourceHealth`
 * (flow_sdk/ingest/health.py); `config_error` reads as "needs attention"
 * because that is what it means operationally: the scheduler has parked it.
 *
 * One table rather than three parallel ones — keyed by the `SourceHealth` union
 * so adding a state is a type error here instead of a silently unstyled chip.
 */
export const HEALTH_STYLE: Record<SourceHealth, { label: string; chip: string; border: string }> = {
  ok: {
    label: 'ok',
    chip: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    border: 'border-s-emerald-500/60',
  },
  never_synced: {
    label: 'never synced',
    chip: 'bg-muted text-muted-foreground',
    border: 'border-s-border',
  },
  transient_error: {
    label: 'retrying',
    chip: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    border: 'border-s-amber-500/70',
  },
  config_error: {
    label: 'needs attention',
    chip: 'bg-destructive/10 text-destructive',
    border: 'border-s-destructive/70',
  },
};

/** The style row for a health value, tolerating one the backend added first. */
export function healthStyle(health: string | undefined) {
  return HEALTH_STYLE[(health || 'never_synced') as SourceHealth] ?? HEALTH_STYLE.never_synced;
}
