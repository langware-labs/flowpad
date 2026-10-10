/**
 * Why a source is not delivering — THE classifier, read by the channel mark, the
 * hover list and the stream inbox's attention strip alike, so the three never disagree.
 *
 * `attentionReason` names the kind from the SDK's own getters and carries the source's
 * own words when it has any (its setup note, its last error); `null` means it listens.
 * `ATTENTION` holds everything else a surface needs to know about a kind, in one row:
 * how the mark draws it, the verb that recovers it, and the sentences to fall back on.
 */
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { DataSource } from '@sdk';

/** unresolved / setup / parked / paused are never polled until a person acts — the four reasons
 *  `DataSource.poll_refusal` gives; held keeps polling but a file waits on a person; retrying is the
 *  scheduler's own backoff after a transient failure, shown so an empty channel explains itself. */
export type AttentionKind = 'unresolved' | 'setup' | 'parked' | 'paused' | 'held' | 'retrying';

export interface AttentionReason {
  kind: AttentionKind;
  /** The source's own words, or empty when it has none. */
  text: string;
}

export function attentionReason(source: DataSource): AttentionReason | null {
  if (source.isUnresolved) return { kind: 'unresolved', text: '' };
  if (source.needsSetup) return { kind: 'setup', text: source.setup_detail || '' };
  if (source.isParked) {
    const code = (source.error_code || '').replace(/_/g, ' ');
    return { kind: 'parked', text: [code, source.error_detail || ''].filter(Boolean).join(': ') };
  }
  if (source.isPaused) return { kind: 'paused', text: '' };
  if (source.isHeld) return { kind: 'held', text: source.error_detail || '' };
  if (source.isRetrying) return { kind: 'retrying', text: source.error_detail || '' };
  return null;
}

/** How a channel mark draws one source: lit, dashed, or wearing "!" because a person must act. */
export type ChannelMark = 'on' | 'off' | 'parked';
export type AttentionVerb = 'verify' | 'resume' | 'pull';

interface AttentionFacts {
  /** Retrying still draws lit — the scheduler will finish on its own. */
  mark: ChannelMark;
  /** The one verb that recovers it: Verify re-runs the check and un-parks, Resume un-pauses, Pull
   *  polls now (and carries a held file on once the two agree). */
  verb: AttentionVerb;
  /** What is wrong, when the source has no words of its own. */
  fallback: MessageDescriptor;
  /** What to do about it. */
  next: MessageDescriptor;
}

export const ATTENTION: Record<AttentionKind, AttentionFacts> = {
  unresolved: {
    mark: 'parked',
    verb: 'verify',
    fallback: msg`Not evaluated yet — nothing has decided how this source starts, so it is not polled.`,
    next: msg`Press Verify to evaluate it now.`,
  },
  setup: {
    mark: 'parked',
    verb: 'verify',
    fallback: msg`Finish setup, then press Verify.`,
    next: msg`Finish the step above, then press Verify.`,
  },
  parked: {
    mark: 'parked',
    verb: 'verify',
    fallback: msg`The last poll failed on a configuration error.`,
    next: msg`Fix the configuration — credentials or settings — then press Verify to resume polling.`,
  },
  paused: {
    mark: 'off',
    verb: 'resume',
    fallback: msg`Paused — nothing is fetched from this channel.`,
    next: msg`Press Resume to listen again.`,
  },
  held: {
    mark: 'parked',
    verb: 'pull',
    fallback: msg`A file changed both here and remotely, so write-back wrote neither.`,
    next: msg`Make the two the same — edit either one — then Pull, or wait for the next sync.`,
  },
  retrying: {
    mark: 'on',
    verb: 'pull',
    fallback: msg`The last poll failed; the scheduler retries on its own.`,
    next: msg`Nothing to do unless it keeps failing; Pull tries again now.`,
  },
};

/** What is wrong, in the source's words or the kind's fallback sentence. */
export const attentionText = (reason: AttentionReason): string =>
  reason.text || i18n._(ATTENTION[reason.kind].fallback);
