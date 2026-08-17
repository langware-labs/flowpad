/**
 * The wording behind the token plan screens: which window a headline speaks
 * about, how long until it resets, and the sentences the hero, the card and the
 * chip render. **Pure** — `now` and the `i18n` used to translate are
 * parameters.
 *
 * The arithmetic itself (`usedRatio`, `ratioTone`, `formatAmount`) belongs to
 * the endpoint layer's `usage-math`; the *choice* of headline belongs to the
 * hub (`resolver.tightest()` over the whole path) and arrives as
 * `scope.headline`. Neither is re-implemented here.
 */
import { msg } from '@lingui/core/macro';
import type { I18n, MessageDescriptor } from '@lingui/core';
import type { TokenPlanRemaining, TokenPlanScope } from '@sdk';

import {
  formatAmount,
  formatUsd,
  isCostKey,
  ratioTone,
  usedRatio,
  type RatioTone,
} from '@src/components/llm-endpoints/usage-math';

/** "resets in 4 h 12 m" / "resets in 3 d" / "resets in 12 m" as a message
 *  descriptor (values embedded — render with `t(descriptor)`); null when the
 *  window never resets or already has. */
export function formatResetsIn(resetsAt: number | null | undefined, now: Date = new Date()): MessageDescriptor | null {
  if (resetsAt === null || resetsAt === undefined) return null;
  const secs = resetsAt - Math.floor(now.getTime() / 1000);
  if (secs <= 0) return null;
  const mins = Math.ceil(secs / 60);
  if (mins < 60) return msg`resets in ${mins} m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const m = mins - hours * 60;
    return m > 0 ? msg`resets in ${hours} h ${m} m` : msg`resets in ${hours} h`;
  }
  const days = Math.round(hours / 24);
  return msg`resets in ${days} d`;
}

/** The window's noun, for sentences: "today" / "this week" / … */
const WINDOW_LABELS: Record<string, MessageDescriptor> = {
  day: msg`today`,
  week: msg`this week`,
  month: msg`this month`,
  total: msg`in total`,
  minute: msg`this minute`,
};

export function windowLabel(window: string): MessageDescriptor {
  return WINDOW_LABELS[window] ?? msg`in this window`;
}

export interface HeadlineText {
  descriptor: MessageDescriptor;
  tone: RatioTone;
}

/**
 * The hero sentence for a headline window (`windowText` = the translated
 * `windowLabel`, e.g. "today"):
 *  - cost → "$1.80 left today"
 *  - tokens → "42% of your token budget used today"
 *  - requests/minute → "12 of 60 requests left this minute"
 * Percent wording for tokens because "1.2M tokens left" reads worse than a
 * share; cost stays absolute because dollars are the unit people plan in.
 */
export function headlineText(headline: TokenPlanRemaining, windowText: string): HeadlineText {
  const ratio = usedRatio(headline);
  const tone = ratioTone(ratio);
  const left = Math.max(0, headline.remaining);
  if (isCostKey(headline.key)) {
    const amount = formatUsd(left);
    return { descriptor: msg`${amount} left ${windowText}`, tone };
  }
  if (headline.key.startsWith('tokens')) {
    const pct = Math.round(ratio * 100);
    return { descriptor: msg`${pct}% of your token budget used ${windowText}`, tone };
  }
  const limit = headline.limit;
  return { descriptor: msg`${left} of ${limit} requests left ${windowText}`, tone };
}

/** Short form for chips/cards: "$3.20 of $5 today" / "12k of 50k today". */
export function budgetText(headline: TokenPlanRemaining, windowText: string): MessageDescriptor {
  const used = formatAmount(headline.key, headline.used);
  const limit = formatAmount(headline.key, headline.limit);
  return msg`${used} of ${limit} ${windowText}`;
}

export function scopeLabel(scope: Pick<TokenPlanScope, 'kind' | 'name'>): MessageDescriptor | string {
  if (scope.kind === 'me') return msg`Me`;
  return scope.name || (scope.kind === 'team' ? msg`Team` : msg`Organization`);
}

/** For "Unlimited here — <parent> caps you at $200 today": non-null when this
 *  scope's own endpoint has no limits but something up the path does. */
export function capsMessage(
  scope: Pick<TokenPlanScope, 'headline' | 'remaining' | 'path'>,
  windowText: string,
): MessageDescriptor | null {
  if (!scope.headline || scope.remaining.some((r) => r.limit > 0)) return null;
  const parentHop = scope.path.length > 1 ? scope.path[1] : scope.path[0];
  if (!parentHop) return null;
  const parent = parentHop.name;
  const limit = formatAmount(scope.headline.key, scope.headline.limit);
  return msg`Unlimited here — ${parent} caps you at ${limit} ${windowText}`;
}

/** Everything the three headline surfaces (hero, home card, harness chip) say
 *  about a scope, translated once. They differ in layout, not in wording — this
 *  is why none of them composes the sentence itself. */
export interface HeadlineView {
  /** The full sentence ("$1.80 left today"); null when nothing caps the scope. */
  text: string | null;
  /** The chip's short form ("$3.20 of $5.00 today"); null when nothing caps. */
  short: string | null;
  tone: RatioTone;
  /** "resets in 4 h"; null when the window never resets (or already did). */
  resets: string | null;
  /** "Unlimited here — Team A caps you at $200.00 today" — set instead of
   *  `text` when the scope itself is unlimited but its path is not. */
  caps: string | null;
}

export function headlineFor(
  scope: Pick<TokenPlanScope, 'headline' | 'remaining' | 'path'>,
  i18n: I18n,
  now?: Date,
): HeadlineView {
  const headline = scope.headline;
  if (!headline) return { text: null, short: null, tone: 'ok', resets: null, caps: null };
  const windowText = i18n._(windowLabel(headline.window));
  const text = headlineText(headline, windowText);
  const caps = capsMessage(scope, windowText);
  const resets = formatResetsIn(headline.resets_at, now);
  return {
    text: i18n._(text.descriptor),
    short: i18n._(budgetText(headline, windowText)),
    tone: text.tone,
    resets: resets ? i18n._(resets) : null,
    caps: caps ? i18n._(caps) : null,
  };
}
