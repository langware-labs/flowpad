/**
 * Which crumbs survive when the address field runs out of room.
 *
 * The rule that matters: the project (first) and the current entity (last) are
 * the two facts a person needs, so neither may ever be the one that hides.
 */
import { describe, it, expect } from 'vitest';
import { FileText } from 'lucide-react';
import { selectVisibleCrumbs, UNMEASURED_CRUMB_LIMIT } from '@src/components/top-nav-bar/crumb-overflow';
import type { Crumb } from '@src/components/top-nav-bar/use-entity-breadcrumbs';

function crumbs(n: number): Crumb[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `k${i}`,
    label: `crumb ${i}`,
    Icon: FileText,
    pointer: null,
    kind: i === 0 ? 'project' : i === n - 1 ? 'current' : 'ancestor',
  }));
}

describe('selectVisibleCrumbs', () => {
  it('hides nothing when everything fits', () => {
    const c = crumbs(4);
    const layout = selectVisibleCrumbs(c, [50, 50, 50, 50], 400);

    expect(layout.hidden).toEqual([]);
    expect(layout.visible).toHaveLength(4);
  });

  it('never hides the project or the current entity', () => {
    const c = crumbs(6);
    const layout = selectVisibleCrumbs(c, [80, 80, 80, 80, 80, 80], 200);

    expect(layout.visible[0]).toBe(c[0]);
    expect(layout.visible[layout.visible.length - 1]).toBe(c[5]);
    expect(layout.hidden.length).toBeGreaterThan(0);
  });

  it('accounts for the ellipsis it is about to render', () => {
    const c = crumbs(4);
    // 4×50 = 200 fits exactly, but not once the ellipsis costs 28.
    const layout = selectVisibleCrumbs(c, [50, 50, 50, 50], 199, 28);

    expect(layout.hidden.length).toBeGreaterThan(0);
    expect(layout.visible[0]).toBe(c[0]);
    expect(layout.visible[layout.visible.length - 1]).toBe(c[3]);
  });

  it('keeps two crumbs whole no matter how narrow it gets', () => {
    const c = crumbs(5);
    const layout = selectVisibleCrumbs(c, [100, 100, 100, 100, 100], 1);

    expect(layout.visible).toHaveLength(2);
    expect(layout.hidden).toHaveLength(3);
  });

  it('leaves a one- or two-crumb address alone', () => {
    expect(selectVisibleCrumbs(crumbs(2), [500, 500], 10).hidden).toEqual([]);
    expect(selectVisibleCrumbs(crumbs(1), [500], 10).hidden).toEqual([]);
  });

  it('falls back to a count rule when nothing has been measured', () => {
    // jsdom (and the first frame before layout) reports every width as 0.
    const short = crumbs(UNMEASURED_CRUMB_LIMIT);
    expect(selectVisibleCrumbs(short, [], 0).hidden).toEqual([]);

    const long = crumbs(UNMEASURED_CRUMB_LIMIT + 1);
    const layout = selectVisibleCrumbs(long, [], 0);
    expect(layout.visible).toHaveLength(2);
    expect(layout.hidden).toHaveLength(UNMEASURED_CRUMB_LIMIT - 1);
  });
});
