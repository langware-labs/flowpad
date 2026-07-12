/**
 * `AgenticProcess.displayStack` + the `context_data.display_stack` deepAssign
 * guard. The stack is an array nested in `context_data`; deepAssign index-merges
 * arrays and never shrinks, so `onEntityUpdate` must REPLACE the stack wholesale
 * and strip it from the payload (the same guard `queue` uses) — else a
 * dedupe/cap/reorder would leave stale tail entries.
 */
import { AgenticProcess, dataManager } from '@sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ID = '37c47bb1-f010-45e2-8ed9-fcad8901f7da';
const A = { kind: 'vfs', path: '/a', shown_at: '2026-07-09T10:00:00Z' };
const B = { kind: 'vfs', path: '/b', shown_at: '2026-07-09T10:01:00Z' };
const C = { kind: 'vfs', path: '/c', shown_at: '2026-07-09T10:02:00Z' };

describe('AgenticProcess display stack', () => {
  beforeEach(async () => {
    await dataManager.clearCache();
  });
  afterEach(async () => {
    await dataManager.clearCache();
  });

  it('exposes context_data.display_stack via the displayStack getter', () => {
    const proc = new AgenticProcess({ id: ID, context_data: { display_stack: [A, B] } });
    expect(proc.displayStack).toEqual([A, B]);
  });

  it('returns [] when no display has been shown', () => {
    expect(new AgenticProcess({ id: ID }).displayStack).toEqual([]);
  });

  it('REPLACES the stack wholesale on update — a shorter stack shrinks (no index-merge)', () => {
    const proc = new AgenticProcess({ id: ID, context_data: { display_stack: [A, B, C], other: 1 } });
    const data: { context_data: Record<string, unknown> } = {
      context_data: { display_stack: [C], other: 2 },
    };

    // Exercise the guard directly (deepAssign runs after this in the store).
    (proc as unknown as { onEntityUpdate: (d: unknown) => void }).onEntityUpdate(data);

    // Stack shrank to the wire value — not [A,B,C] merged with [C] by index.
    expect(proc.displayStack).toEqual([C]);
    // Stripped from the payload so the following deepAssign leaves it alone…
    expect('display_stack' in data.context_data).toBe(false);
    // …while the REST of context_data still flows through deepAssign.
    expect(data.context_data.other).toBe(2);
  });
});
