/**
 * `token-plan-math` — resets-in wording, the hero / chip sentences, and the one
 * `headlineFor` view the three headline surfaces render. Pure; the clock is
 * pinned. The arithmetic (used ratio, tone) is the endpoint layer's and is
 * covered by `llm-endpoint-usage-math`.
 */
import { i18n } from '@lingui/core';
import type { TokenPlanRemaining } from '@sdk';
import { describe, expect, it } from 'vitest';

import {
  budgetText,
  capsMessage,
  formatResetsIn,
  headlineFor,
  headlineText,
  scopeLabel,
  windowLabel,
} from '@src/components/token-plan/token-plan-math';

const NOW = new Date('2026-08-18T10:00:00Z');
const now = Math.floor(NOW.getTime() / 1000);

const r = (over: Partial<TokenPlanRemaining>): TokenPlanRemaining => ({
  key: 'cost_usd_per_day',
  used: 0,
  limit: 10,
  remaining: 10,
  resets_at: null,
  window: 'day',
  ...over,
});

const render = (d: Parameters<typeof i18n._>[0]) => i18n._(d);

describe('formatResetsIn', () => {
  it('formats minutes, hours+minutes, hours and days', () => {
    expect(render(formatResetsIn(now + 12 * 60, NOW)!)).toBe('resets in 12 m');
    expect(render(formatResetsIn(now + 4 * 3600 + 12 * 60, NOW)!)).toBe('resets in 4 h 12 m');
    expect(render(formatResetsIn(now + 4 * 3600, NOW)!)).toBe('resets in 4 h');
    expect(render(formatResetsIn(now + 3 * 86400, NOW)!)).toBe('resets in 3 d');
  });

  it('is null for never / already reset', () => {
    expect(formatResetsIn(null, NOW)).toBeNull();
    expect(formatResetsIn(undefined, NOW)).toBeNull();
    expect(formatResetsIn(now - 1, NOW)).toBeNull();
  });
});

describe('headlineText / budgetText', () => {
  it('cost → dollars left, with the tone of the fill', () => {
    const h = headlineText(r({ used: 8.2, limit: 10, remaining: 1.8 }), 'today');
    expect(render(h.descriptor)).toBe('$1.80 left today');
    expect(h.tone).toBe('amber');
  });

  it('tokens → percent used', () => {
    const h = headlineText(
      r({ key: 'tokens_per_month', used: 42_000, limit: 100_000, remaining: 58_000, window: 'month' }),
      'this month',
    );
    expect(render(h.descriptor)).toBe('42% of your token budget used this month');
    expect(h.tone).toBe('ok');
  });

  it('requests → n of m left', () => {
    const h = headlineText(
      r({ key: 'requests_per_minute', used: 55, limit: 60, remaining: 5, window: 'minute' }),
      'this minute',
    );
    expect(render(h.descriptor)).toBe('5 of 60 requests left this minute');
    expect(h.tone).toBe('destructive');
  });

  it('budgetText is the short chip form', () => {
    expect(render(budgetText(r({ used: 3.2, limit: 5, remaining: 1.8 }), 'today'))).toBe('$3.20 of $5.00 today');
  });
});

describe('capsMessage / windows / labels', () => {
  it('names the parent cap when this scope has no limits but the path does', () => {
    const msg = capsMessage(
      {
        headline: r({ key: 'cost_usd_per_day', limit: 200, used: 10, remaining: 190 }),
        remaining: [],
        path: [
          { endpoint_id: 'me', name: 'default-me', kind: 'me' },
          { endpoint_id: 't', name: 'Team A', kind: 'team' },
        ],
      },
      'today',
    );
    expect(render(msg!)).toBe('Unlimited here — Team A caps you at $200.00 today');
  });

  it('is null when the scope has its own limits or no headline', () => {
    expect(capsMessage({ headline: null, remaining: [], path: [] }, 'today')).toBeNull();
    expect(capsMessage({ headline: r({}), remaining: [r({})], path: [] }, 'today')).toBeNull();
  });

  it('labels the windows the hub sends', () => {
    expect(render(windowLabel('day'))).toBe('today');
    expect(render(windowLabel('month'))).toBe('this month');
    expect(render(windowLabel('total'))).toBe('in total');
  });

  it('labels scopes: me is "Me", others by name', () => {
    expect(render(scopeLabel({ kind: 'me', name: 'Eran' }) as never)).toBe('Me');
    expect(scopeLabel({ kind: 'team', name: 'Team A' })).toBe('Team A');
    expect(render(scopeLabel({ kind: 'org', name: '' }) as never)).toBe('Organization');
  });
});

describe('headlineFor', () => {
  const scope = (over: Partial<Parameters<typeof headlineFor>[0]>) => ({
    headline: null,
    remaining: [],
    path: [],
    ...over,
  });

  it('gives every surface the same sentence, short form, tone and reset', () => {
    const headline = r({ used: 3.2, limit: 5, remaining: 1.8, resets_at: now + 4 * 3600 });
    const view = headlineFor(scope({ headline, remaining: [headline] }), i18n, NOW);
    expect(view.text).toBe('$1.80 left today');
    expect(view.short).toBe('$3.20 of $5.00 today');
    expect(view.resets).toBe('resets in 4 h');
    expect(view.tone).toBe('ok'); // 64 % used
    expect(view.caps).toBeNull();
  });

  it('says who caps you when this scope is unlimited but the path is not', () => {
    const view = headlineFor(
      scope({
        headline: r({ limit: 200, used: 10, remaining: 190 }),
        path: [
          { endpoint_id: 'me', name: 'default-me', kind: 'me' },
          { endpoint_id: 't', name: 'Team A', kind: 'team' },
        ],
      }),
      i18n,
      NOW,
    );
    expect(view.caps).toBe('Unlimited here — Team A caps you at $200.00 today');
    expect(view.text).toBe('$190.00 left today');
  });

  it('is all-null when nothing caps the scope', () => {
    const view = headlineFor(scope({}), i18n, NOW);
    expect(view).toMatchObject({ text: null, short: null, caps: null, resets: null, tone: 'ok' });
  });
});
