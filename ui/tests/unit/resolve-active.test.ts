/**
 * Phase-1: the new single resolver `resolveActive`. Locks all 5 precedence cases
 * plus the consume-once / not-a-member edges. Pure — no React, no SDK.
 */
import { describe, expect, it } from 'vitest';
import { type TabCandidate, resolveActive } from '@sdk/tabs';

const c = (key: string, lastActiveAt: number | null, tabOrder: number): TabCandidate => ({
  key,
  lastActiveAt,
  tabOrder,
});

describe('resolveActive — precedence', () => {
  it('case 1: URL target that is a live member wins, no navigation implied', () => {
    const r = resolveActive({
      candidates: [c('a', 100, 0), c('b', 999, 1)],
      urlActiveKey: 'a',
      pendingIntentKey: 'b',
    });
    expect(r).toEqual({ activeKey: 'a', source: 'url', consumedPendingIntent: false });
  });

  it('case 2: pending intent (in list) wins over recency, and is consumed', () => {
    const r = resolveActive({
      candidates: [c('a', 999, 0), c('b', 100, 1)],
      urlActiveKey: null,
      pendingIntentKey: 'b',
    });
    expect(r).toEqual({ activeKey: 'b', source: 'intent', consumedPendingIntent: true });
  });

  it('case 3: falls back to the most-recently-active member', () => {
    const r = resolveActive({
      candidates: [c('a', 100, 0), c('b', 500, 1), c('c', 200, 2)],
      urlActiveKey: null,
      pendingIntentKey: null,
    });
    expect(r.activeKey).toBe('b');
    expect(r.source).toBe('recency');
  });

  it('case 3: recency ties break by lowest tabOrder', () => {
    const r = resolveActive({
      candidates: [c('a', 500, 3), c('b', 500, 1)],
      urlActiveKey: null,
      pendingIntentKey: null,
    });
    expect(r.activeKey).toBe('b');
  });

  it('case 4: with no recency signal, picks the lowest tabOrder', () => {
    const r = resolveActive({
      candidates: [c('a', null, 2), c('b', null, 0), c('c', null, 1)],
      urlActiveKey: null,
      pendingIntentKey: null,
    });
    expect(r.activeKey).toBe('b');
    expect(r.source).toBe('order');
  });

  it('case 5: empty surface resolves to none', () => {
    const r = resolveActive({ candidates: [], urlActiveKey: 'a', pendingIntentKey: 'b' });
    expect(r).toEqual({ activeKey: null, source: 'none', consumedPendingIntent: false });
  });
});

describe('resolveActive — edges', () => {
  it('a pending intent NOT in the list is ignored (not consumed) and falls through', () => {
    const r = resolveActive({
      candidates: [c('a', 100, 0)],
      urlActiveKey: null,
      pendingIntentKey: 'ghost',
    });
    expect(r.activeKey).toBe('a');
    expect(r.source).toBe('recency');
    expect(r.consumedPendingIntent).toBe(false);
  });

  it('a dead URL target falls through to the intent', () => {
    const r = resolveActive({
      candidates: [c('a', 100, 0), c('b', 100, 1)],
      urlActiveKey: 'gone',
      pendingIntentKey: 'b',
    });
    expect(r.activeKey).toBe('b');
    expect(r.source).toBe('intent');
  });
});
