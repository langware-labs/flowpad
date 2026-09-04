/**
 * The arithmetic behind "you cannot give out more than you have".
 *
 * Pure, and tested apart from the components that use it, because the rules that matter here are
 * not obvious from the call sites: what an uncapped pool means, what an already-over-promised pool
 * means, and why a row's own current cap is added back before the sum is judged.
 */
import { describe, expect, it } from 'vitest';

import {
  allocationProblem,
  availableToAllocate,
  batchFits,
} from '@src/components/organization/budgets/available-to-allocate';

describe('availableToAllocate', () => {
  it('is what the pool holds minus what it has already given out', () => {
    expect(availableToAllocate({ limit_usd: 100, allocated_usd: 40 })).toBe(60);
  });

  it('adds the row back, because editing a budget replaces it rather than adding to it', () => {
    // A $100 org that has given out $40, of which this team holds $30: the team may go up to $90,
    // not to $60. Charging its own money against it is the mistake this exists to prevent.
    expect(availableToAllocate({ limit_usd: 100, allocated_usd: 40 }, 30)).toBe(90);
  });

  it('has no ceiling to offer when the pool itself is uncapped', () => {
    expect(availableToAllocate({ limit_usd: null, allocated_usd: 40 })).toBeNull();
  });

  it('has no ceiling to offer when the children were never read', () => {
    // A team row inside the ORG view leaves `allocated_usd` null on purpose. Treating that as zero
    // would report the team's entire cap as free and wave through a double allocation.
    expect(availableToAllocate({ limit_usd: 100, allocated_usd: null })).toBeNull();
  });

  it('reads an already over-promised pool as empty, never as negative', () => {
    // The hub permits this state, and older data has it. A negative allowance would make every
    // edit on the row look impossible, including lowering it.
    expect(availableToAllocate({ limit_usd: 50, allocated_usd: 80 })).toBe(0);
  });

  it('is exact in cents', () => {
    expect(availableToAllocate({ limit_usd: 20.3, allocated_usd: 0.1 })).toBe(20.2);
  });
});

describe('allocationProblem', () => {
  it('accepts an amount that fits, and the exact remainder', () => {
    expect(allocationProblem(60, 60)).toBeUndefined();
    expect(allocationProblem(59.99, 60)).toBeUndefined();
  });

  it('refuses an amount larger than what is left', () => {
    expect(allocationProblem(60.01, 60)).toBe('over');
  });

  it('refuses "unlimited" under a real ceiling, as its own kind of problem', () => {
    // Blank means uncapped, and uncapped is by definition more than whatever is left. It is
    // reported separately so the message can say that rather than quoting a number at someone who
    // typed no number at all.
    expect(allocationProblem(null, 60)).toBe('unlimited-under-cap');
  });

  it('accepts anything at all when there is no ceiling', () => {
    expect(allocationProblem(10 ** 9, null)).toBeUndefined();
    expect(allocationProblem(null, null)).toBeUndefined();
  });
});

describe('batchFits', () => {
  const pool = { limit_usd: 50, allocated_usd: 0 };

  it('weighs the whole sheet at once, not row by row', () => {
    // Each of these fits on its own; together they do not. Checking them individually is the bug
    // this function exists to prevent.
    expect(batchFits([10, 10, 10, 10, 10, 10], pool).fits).toBe(false);
    expect(batchFits([10, 10, 10, 10, 10], pool).fits).toBe(true);
  });

  it('frees what the sheet overwrites before judging it', () => {
    // Re-budgeting someone from $20 to $30 in a full pool costs $10, not $30.
    expect(batchFits([30], { limit_usd: 50, allocated_usd: 50 }, 20).fits).toBe(false);
    expect(batchFits([30], { limit_usd: 50, allocated_usd: 40 }, 20).fits).toBe(true);
  });

  it('refuses a sheet with a blank amount under a capped pool', () => {
    expect(batchFits([10, null], pool).fits).toBe(false);
  });

  it('accepts anything under an uncapped pool, blanks included', () => {
    const result = batchFits([10, null], { limit_usd: null, allocated_usd: 0 });
    expect(result.fits).toBe(true);
    expect(result.available).toBeNull();
  });

  it('reports the total so the refusal can name both numbers', () => {
    expect(batchFits([10.1, 20.2], pool).total).toBe(30.3);
  });
});
