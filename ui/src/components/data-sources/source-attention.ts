/**
 * Why a source is not listening — THE classifier, read by the channel mark, the
 * hover list and the stream inbox's attention strip alike, so the three never disagree.
 *
 * Three kinds, from the SDK's own getters: a setup step is owed, it is parked on a
 * configuration error, or it is paused. `null` means it listens. Each kind carries
 * the source's own words when it has any (its setup note, its last error) and a
 * fallback sentence when it does not.
 */
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { DataSource } from '@sdk';

/** setup / parked / paused stop polling until a person acts; held keeps polling but a file waits on a
 *  person; retrying is the scheduler's own backoff after a transient failure, shown so an empty
 *  channel explains itself. */
export type AttentionKind = 'setup' | 'parked' | 'paused' | 'held' | 'retrying';

export interface AttentionReason {
  kind: AttentionKind;
  /** The source's own words, or empty when it only says "paused". */
  text: string;
}

export function attentionReason(source: DataSource): AttentionReason | null {
  if (source.needsSetup) return { kind: 'setup', text: source.setup_detail || '' };
  if (source.isParked) {
    const code = (source.error_code || '').replace(/_/g, ' ');
    return { kind: 'parked', text: [code, source.error_detail || ''].filter(Boolean).join(': ') };
  }
  if (source.isPaused) return { kind: 'paused', text: '' };
  if (source.isHeld) return { kind: 'held', text: source.error_detail || '' };
  if (source.isActive && source.health === 'transient_error') return { kind: 'retrying', text: source.error_detail || '' };
  return null;
}

/** Whether a person has to act: the scheduler will not (or cannot) finish on its own. */
export const needsAPerson = (kind: AttentionKind): boolean => kind !== 'retrying';

/** What is wrong, when the source has no words of its own. Translated where drawn (`i18n._`). */
export const ATTENTION_FALLBACK: Record<AttentionKind, MessageDescriptor> = {
  setup: msg`Finish setup, then press Verify.`,
  parked: msg`The last poll failed on a configuration error.`,
  paused: msg`Paused — nothing is fetched from this channel.`,
  held: msg`A file changed both here and remotely, so write-back wrote neither.`,
  retrying: msg`The last poll failed; the scheduler retries on its own.`,
};

/** What to do about it, by kind. */
export const ATTENTION_NEXT_STEP: Record<AttentionKind, MessageDescriptor> = {
  setup: msg`Finish the step above, then press Verify.`,
  parked: msg`Fix the configuration — credentials or settings — then press Verify to resume polling.`,
  paused: msg`Press Resume to listen again.`,
  held: msg`Make the two the same — edit either one — then Pull, or wait for the next sync.`,
  retrying: msg`Nothing to do unless it keeps failing; Pull tries again now.`,
};
