/**
 * Why a source is not listening — THE classifier, read by the channel mark, the
 * hover list and the inbox's attention strip alike, so the three never disagree.
 *
 * Three kinds, from the SDK's own getters: a setup step is owed, it is parked on a
 * configuration error, or it is paused. `null` means it listens. Each kind carries
 * the source's own words when it has any (its setup note, its last error) and a
 * fallback sentence when it does not.
 */
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { DataSource } from '@sdk';

export type AttentionKind = 'setup' | 'parked' | 'paused';

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
  return null;
}

/** What is wrong, when the source has no words of its own. Translated where drawn (`i18n._`). */
export const ATTENTION_FALLBACK: Record<AttentionKind, MessageDescriptor> = {
  setup: msg`Finish setup, then press Verify.`,
  parked: msg`The last poll failed on a configuration error.`,
  paused: msg`Paused — nothing is fetched from this channel.`,
};

/** What to do about it, by kind. */
export const ATTENTION_NEXT_STEP: Record<AttentionKind, MessageDescriptor> = {
  setup: msg`Finish the step above, then press Verify.`,
  parked: msg`Fix the configuration — credentials or settings — then press Verify to resume polling.`,
  paused: msg`Press Resume to listen again.`,
};
