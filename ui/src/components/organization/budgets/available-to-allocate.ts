/**
 * How much of a pool is still free to hand out — and whether a typed amount fits.
 *
 * **This is a UI-side refusal, and deliberately only that.** The hub lets a pool promise more than
 * it holds and catches the excess when the money is actually SPENT, along the whole chain up to the
 * org root (see the header of `BudgetSection.tsx`). That stays true: nothing here is a security
 * control, an org admin cannot overspend an organization whatever they type, and a CSV import or a
 * direct API call is still accepted by the hub. What this adds is that a person dividing a budget
 * by hand is told "that is more than is left" at the moment they type it, instead of discovering it
 * as a refused request weeks later when someone's work stops.
 *
 * The arithmetic uses exactly the two numbers already on the screen — the pool's own cap and the
 * sum of what it has given out — so the answer can never disagree with what the page displays.
 *
 * Two rules that look like edge cases and are not:
 *
 * * **An uncapped pool bounds nothing**, so it returns `null` and every amount fits. Blocking
 *   against an unknown ceiling would be inventing one.
 * * **Under a capped pool, "unlimited" is refused.** Blank means uncapped, and uncapped is by
 *   definition more than whatever is left. This mirrors the hub's own reading: `_allocated` counts
 *   an uncapped child as contributing nothing, precisely because "unbounded" has no honest number.
 */

/** Cents, so 20.3 − 0.1 − 0.1 does not become 20.099999999999998 in a comparison. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface PoolFunds {
  /** The pool's own lifetime cap; `null` = uncapped. */
  limit_usd: number | null;
  /** Sum of the caps already handed out of it; `null` when the caller did not read the children. */
  allocated_usd: number | null;
}

/**
 * What is still free in `pool`, for a row currently holding `rowCap`.
 *
 * `rowCap` is added back because editing a row is a REPLACEMENT, not an addition: a team already
 * holding $20 out of a $100 pool may be raised to $80, not just to $60. Pass `null` for a row that
 * does not exist yet (a new person, a new team).
 *
 * `null` means "no ceiling to check against" — an uncapped pool, or a pool whose children were
 * never read, where a limit would be guesswork.
 */
export function availableToAllocate(pool: PoolFunds, rowCap: number | null = null): number | null {
  if (pool.limit_usd === null || pool.limit_usd === undefined) return null;
  if (pool.allocated_usd === null || pool.allocated_usd === undefined) return null;
  // Clamped at zero: a pool that has already over-promised (which the hub permits) must read as
  // "nothing left", never as a negative allowance that would make every edit look impossible.
  const givenToOthers = Math.max(0, round2(pool.allocated_usd - (rowCap ?? 0)));
  return Math.max(0, round2(pool.limit_usd - givenToOthers));
}

/**
 * Whether `next` fits in `available`. `undefined` means it fits.
 *
 * `next === null` is "unlimited", which never fits under a real ceiling. The two refusals are
 * returned as distinct kinds rather than one boolean so the caller can word them differently — a
 * number that is simply too big and a request for no limit at all are different mistakes.
 */
export type AllocationProblem = 'over' | 'unlimited-under-cap';

export function allocationProblem(next: number | null, available: number | null): AllocationProblem | undefined {
  if (available === null) return undefined;
  if (next === null) return 'unlimited-under-cap';
  return round2(next) > available ? 'over' : undefined;
}

/**
 * The same question for a batch: does the total of several new allowances fit at once?
 *
 * The add-people dialog writes a whole sheet in one press, and checking each row against the pool
 * on its own would wave through forty rows of $10 against a pool holding $50. `replacing` is the
 * sum of the caps of rows these drafts overwrite — a repeated address re-budgets that person rather
 * than adding a second allowance, so their old cap comes back into the pot first.
 */
export function batchFits(
  drafts: readonly (number | null)[],
  pool: PoolFunds,
  replacing = 0,
): { fits: boolean; available: number | null; total: number } {
  const available = availableToAllocate(pool, replacing);
  const total = round2(drafts.reduce<number>((sum, cap) => sum + (cap ?? 0), 0));
  if (available === null) return { fits: true, available, total };
  if (drafts.some((cap) => cap === null)) return { fits: false, available, total };
  return { fits: total <= available, available, total };
}
