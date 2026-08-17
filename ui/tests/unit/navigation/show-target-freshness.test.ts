/**
 * Regression test for `isFreshShow` — the gate that decides whether a PERSISTED
 * `flow show` (`context_data.display_stack`) is news to a freshly-mounted client.
 *
 * The bug this exists for was reproduced in a browser: a document tab the user
 * had closed came back on every reload. The first gate used a "first observation
 * establishes a baseline" flag, which is fine for the vibe surfaces (each watches
 * ONE process) but wrong for the global listener, which serves every process —
 * some unrelated process's update consumed the baseline and every stale target
 * then sailed through. The fix is a per-event timestamp comparison, so these
 * cases are about time, never about call order.
 */
import { describe, expect, it } from 'vitest';
import { isFreshShow } from '@src/hooks/use-show-target-listener';

const MOUNT = Date.parse('2026-07-30T12:00:00Z');
const at = (iso: string) => [{ shown_at: iso }];

describe('isFreshShow', () => {
  it('accepts a show stamped after the mount', () => {
    expect(isFreshShow(at('2026-07-30T12:00:05Z'), MOUNT)).toBe(true);
  });

  it('accepts a show stamped exactly at the mount', () => {
    expect(isFreshShow(at('2026-07-30T12:00:00Z'), MOUNT)).toBe(true);
  });

  it('rejects a show stamped before the mount — a closed tab must stay closed', () => {
    expect(isFreshShow(at('2026-07-30T11:59:59Z'), MOUNT)).toBe(false);
  });

  it('reads the NEWEST entry, not the first (stack is oldest-first)', () => {
    const stack = [{ shown_at: '2026-07-30T11:00:00Z' }, { shown_at: '2026-07-30T12:00:10Z' }];
    expect(isFreshShow(stack, MOUNT)).toBe(true);
    const stale = [{ shown_at: '2026-07-30T12:00:10Z' }, { shown_at: '2026-07-30T11:00:00Z' }];
    expect(isFreshShow(stale, MOUNT)).toBe(false);
  });

  it('rejects an empty, missing or unparseable stamp rather than defaulting to fresh', () => {
    expect(isFreshShow([], MOUNT)).toBe(false);
    expect(isFreshShow(undefined, MOUNT)).toBe(false);
    expect(isFreshShow([{}], MOUNT)).toBe(false);
    expect(isFreshShow(at('not-a-date'), MOUNT)).toBe(false);
  });

  it('is order-independent — repeated calls never "consume" anything', () => {
    // The exact failure mode of the old baseline-flag design: an unrelated
    // process's fresh show must not make a later stale one pass.
    expect(isFreshShow(at('2026-07-30T12:00:05Z'), MOUNT)).toBe(true);
    expect(isFreshShow(at('2026-07-30T11:00:00Z'), MOUNT)).toBe(false);
    expect(isFreshShow(at('2026-07-30T11:00:00Z'), MOUNT)).toBe(false);
  });
});
