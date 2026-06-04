/**
 * Phase-1 (re-pointed from Phase-0): the self-heal now resolves via the single
 * `resolveActive` precedence function instead of unconditionally snapping to
 * `visibleSessions[0]`. This locks: it consults `resolveActive`, honors a
 * pending intent (Bug 2), is recency-seeded (Bug 1), stays URL-first, and no
 * longer contains the index-0 snap.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(
  resolve(__dirname, '../../src/components/terminal/TabbedTerminal.tsx'),
  'utf-8',
);

describe('TabbedTerminal self-heal — resolver-based (Phase 1)', () => {
  it('resolves the target via resolveActive, not a hard index-0 snap', () => {
    expect(src).toContain('resolveActive({');
    expect(src).not.toContain('const firstSession = visibleSessions[0];');
  });

  it('honors a pending intent (Bug 2) and is recency-seeded (Bug 1)', () => {
    expect(src).toContain('pendingIntentKey: peekPendingIntent()');
    expect(src).toContain('candidates: buildTabCandidates(visibleSessions)');
    expect(src).toContain('if (consumedPendingIntent) consumePendingIntent();');
  });

  it('stays URL-first: it navigates, no optimistic active write', () => {
    expect(src).toContain('navigation.openDockPointer(pointer)');
  });
});
