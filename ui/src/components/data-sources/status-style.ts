/**
 * How a source's LIFECYCLE looks — the companion of `health-style`, and
 * deliberately not merged with it.
 *
 * They answer different questions: status is "should this be running", health
 * is "does it work". One table would have to invent combinations that never
 * occur (a `disabled` source has no health worth showing) and would lose the
 * one distinction the chip exists to draw — that a source waiting on a Slack
 * invite is unfinished, not broken.
 */
import type { SourceStatus } from '@sdk';

/**
 * Status → the chip. Keyed by the `SourceStatus` union, so a state added on the
 * backend is a type error here rather than an unstyled chip.
 *
 * `new` should never reach the UI — `save()` resolves it to `setup` or `active`
 * before the row lands — but it is styled anyway: a row that somehow arrives in
 * it must read as unfinished, not as an empty chip nobody can explain.
 */
export const STATUS_STYLE: Record<SourceStatus, { label: string; chip: string; border: string }> = {
  new: {
    label: 'new',
    chip: 'bg-muted text-muted-foreground',
    border: 'border-s-border',
  },
  setup: {
    label: 'needs setup',
    chip: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    border: 'border-s-amber-500/70',
  },
  active: {
    label: 'active',
    chip: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    border: 'border-s-emerald-500/60',
  },
  disabled: {
    label: 'paused',
    chip: 'bg-muted text-muted-foreground',
    border: 'border-s-border',
  },
};

/** The style row for a status value, tolerating one the backend added first. */
export function statusStyle(status: string | undefined) {
  return STATUS_STYLE[(status || 'new') as SourceStatus] ?? STATUS_STYLE.new;
}
