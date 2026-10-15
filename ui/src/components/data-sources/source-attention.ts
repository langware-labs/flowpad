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
import type { DataSource, SetupNeed } from '@sdk';

/** unresolved / setup / parked / paused are never polled until a person acts — the four reasons
 *  `DataSource.poll_refusal` gives; held keeps polling but a file waits on a person; mirror keeps
 *  polling but the dataset it mirrors into is not current (the sweep failed, or records did not fit);
 *  retrying is the scheduler's own backoff after a transient failure, shown so an empty channel
 *  explains itself. */
export type AttentionKind = 'unresolved' | 'setup' | 'parked' | 'paused' | 'held' | 'mirror' | 'retrying';

export interface AttentionReason {
  kind: AttentionKind;
  /** The source's own words, or empty when it has none. */
  text: string;
  /** A source in setup that waits on a sign-in: which one. It names the strip ("Needs GitHub sign-in"). */
  need?: SetupNeed;
}

export function attentionReason(source: DataSource): AttentionReason | null {
  if (source.isUnresolved) return { kind: 'unresolved', text: '' };
  if (source.needsSetup) {
    const need = (source.setup_needs ?? []).find((n) => n.kind === 'connection');
    return { kind: 'setup', text: source.setup_detail || '', ...(need ? { need } : {}) };
  }
  if (source.isParked) {
    const code = (source.error_code || '').replace(/_/g, ' ');
    return { kind: 'parked', text: [code, source.error_detail || ''].filter(Boolean).join(': ') };
  }
  if (source.isPaused) return { kind: 'paused', text: '' };
  if (source.isHeld) return { kind: 'held', text: source.error_detail || '' };
  if (source.isMirrorBroken) return { kind: 'mirror', text: source.error_detail || '' };
  if (source.isRetrying) return { kind: 'retrying', text: source.error_detail || '' };
  return null;
}

/** How a channel mark draws one source: lit, dashed, or wearing "!" because a person must act. */
export type ChannelMark = 'on' | 'off' | 'parked';
export type AttentionVerb = 'setup' | 'verify' | 'resume' | 'pull';

interface AttentionFacts {
  /** Retrying still draws lit — the scheduler will finish on its own. */
  mark: ChannelMark;
  /** The one verb that recovers it: Setup opens the source's own setup, Verify re-runs the check and
   *  un-parks, Resume un-pauses, Pull polls now (and carries a held file on once the two agree). */
  verb: AttentionVerb;
  /** A second verb offered beside it — Verify, for whoever finished the setup somewhere else. */
  also?: AttentionVerb;
  /** What a person reads first, when the kind has ONE name for every source in it — the source's own
   *  words are then the detail behind it, never the headline. */
  headline?: MessageDescriptor;
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
    verb: 'setup',
    also: 'verify',
    headline: msg`Setup required`,
    fallback: msg`Finish setup, then press Verify.`,
    next: msg`Press Setup to finish it.`,
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
  mirror: {
    mark: 'parked',
    verb: 'pull',
    headline: msg`Mirror needs attention`,
    fallback: msg`The dataset this source mirrors into could not be made current.`,
    next: msg`Fix the mirror map or the rows it names (the detail says which), then Pull, or wait for the next sync.`,
  },
  retrying: {
    mark: 'on',
    verb: 'pull',
    fallback: msg`The last poll failed; the scheduler retries on its own.`,
    next: msg`Nothing to do unless it keeps failing; Pull tries again now.`,
  },
};

/** What a source waiting on a sign-in is called: its provider's name, else the provider id. */
const needTitle = (need: SetupNeed): string => need.title || need.name || '';

/** The first line a surface shows: the sign-in it waits on, the kind's one name when it has one, else what
 *  is wrong. */
export const attentionHeadline = (reason: AttentionReason): string => {
  if (reason.need) {
    const title = needTitle(reason.need);
    return reason.need.state === 'needs_reauth'
      ? i18n._(msg`${title} sign-in needs renewing`)
      : i18n._(msg`Needs ${title} sign-in`);
  }
  const { headline } = ATTENTION[reason.kind];
  return headline ? i18n._(headline) : attentionText(reason);
};

/** What to do next: for a sign-in, the one sentence that says what nothing-arrives means; else the kind's. */
export const attentionNext = (reason: AttentionReason): string => {
  if (reason.need) {
    const title = needTitle(reason.need);
    return i18n._(msg`Nothing arrives until ${title} is connected. Press Setup — it takes a minute.`);
  }
  return i18n._(ATTENTION[reason.kind].next);
};

/** The verbs a surface offers for a source, the recovering one first; none when it listens. */
export const attentionVerbs = (reason: AttentionReason | null): AttentionVerb[] => {
  if (!reason) return [];
  const { verb, also } = ATTENTION[reason.kind];
  return also ? [verb, also] : [verb];
};

/** What is wrong, in the source's words or the kind's fallback sentence. */
export const attentionText = (reason: AttentionReason): string =>
  reason.text || i18n._(ATTENTION[reason.kind].fallback);
