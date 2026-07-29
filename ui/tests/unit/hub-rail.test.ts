/**
 * The hub rail's membership and order.
 *
 * A pure builder rather than the rendered sidebar, so this stays a ~10-line
 * test instead of standing up a dozen providers. The last assertion guards the
 * invariant that makes two id unions worth having: a hub id must never appear
 * in the desk rail, where `RAIL_ITEMS` would render it as a silent `null`.
 */
import { ViewType, WorldViewProjection } from '@sdk';
import { describe, it, expect } from 'vitest';

import { buildHubRailItems } from '@src/components/collapsed-sidebar/hub-rail';
import { RAIL_ITEMS } from '@src/components/collapsed-sidebar/rail-visibility';

const t = (s: TemplateStringsArray) => s.join('');

describe('buildHubRailItems', () => {
  it('ends with Credentials, exactly once', () => {
    const items = buildHubRailItems(t);
    const ids = items.map((i) => i.id);

    expect(ids.filter((id) => id === 'credentials')).toHaveLength(1);
    expect(ids[ids.length - 1]).toBe('credentials');
  });

  it('opens the Credentials view with no pointer', () => {
    const item = buildHubRailItems(t).find((i) => i.id === 'credentials');

    expect(item?.viewType).toBe(ViewType.CREDENTIALS);
    // Pointer-less on purpose: `hubActive` matches pointer-carrying items on
    // viewType AND pointer, so a pointer would unlight the icon as soon as the
    // user switched tab or project.
    expect(item?.pointer).toBeUndefined();
  });

  it('keeps the content browsers ahead of it, in order', () => {
    expect(buildHubRailItems(t).map((i) => i.id)).toEqual([
      'home',
      'conversations',
      'tasks',
      'docs',
      'flows',
      'world',
      'organization',
      'credentials',
    ]);
  });

  it('distinguishes the two WorldView entries by pointer', () => {
    const items = buildHubRailItems(t);

    expect(items.find((i) => i.id === 'world')?.pointer).toBe(WorldViewProjection.WORLD);
    expect(items.find((i) => i.id === 'organization')?.pointer).toBe(WorldViewProjection.ORGANIZATION);
  });

  it('never leaks credentials into the desk rail', () => {
    // The two unions overlap where a destination genuinely exists on both rails
    // ('home'). Credentials is hub-only for now, and putting its id in
    // RAIL_ITEMS would render a silent `null` slot on the desk.
    expect(RAIL_ITEMS.map((i) => i.id as string)).not.toContain('credentials');
  });
});
