/**
 * How a source's LIFECYCLE looks — the companion of `health-style`, and
 * deliberately not merged with it.
 *
 * They answer different questions: status is "should this be running", health
 * is "does it work". One table would have to invent combinations that never
 * occur (a `disabled` source has no health worth showing) and would lose the
 * one distinction the status line exists to draw — that a source waiting on a
 * Slack invite is unfinished, not broken.
 */
import { msg } from '@lingui/core/macro';
import type { SourceStatus } from '@sdk';
import { type SourceLook } from './source-look';

/**
 * Status → the status line. Keyed by the `SourceStatus` union, so a state added
 * on the backend is a type error here rather than an unstyled line.
 *
 * `new` should never reach the UI — `save()` resolves it to `setup` or `active`
 * before the row lands — but it is styled anyway: a row that somehow arrives in
 * it must read as unfinished, not as an empty line nobody can explain.
 */
export const STATUS_STYLE: Record<SourceStatus, SourceLook> = {
  new: {
    label: msg`New`,
    dot: 'bg-muted-foreground/50',
    text: 'text-muted-foreground',
    border: 'border-s-border',
  },
  setup: {
    label: msg`Needs setup`,
    dot: 'bg-amber-500',
    text: 'text-amber-600 dark:text-amber-400',
    border: 'border-s-amber-500/70',
  },
  active: {
    label: msg`Active`,
    dot: 'bg-emerald-500',
    text: 'text-emerald-600 dark:text-emerald-400',
    border: 'border-s-emerald-500/60',
  },
  disabled: {
    label: msg`Paused`,
    dot: 'bg-muted-foreground/50',
    text: 'text-muted-foreground',
    border: 'border-s-border',
  },
};

/** The style row for a status value, tolerating one the backend added first. */
export function statusStyle(status: string | undefined): SourceLook {
  return STATUS_STYLE[(status || 'new') as SourceStatus] ?? STATUS_STYLE.new;
}
