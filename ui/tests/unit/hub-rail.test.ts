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
      'inbox',
      'tasks',
      'docs',
      'world',
      'organization',
      'token-plan',
      'llm-endpoints',
      'credentials',
    ]);
  });

  it('leaves Home and the project to the top navigation bar', () => {
    // Both moved there: Home is a nav button, the project is the leading
    // breadcrumb. The bar renders on the hub too, so a rail copy would be a
    // second button onto the same destination.
    const ids = buildHubRailItems(t).map((i) => i.id);

    expect(ids).not.toContain('home');
    expect(ids).not.toContain('project');
  });

  it('points each record browser at a type the HUB serves', () => {
    // The pointer goes straight into `graph/<type>` (HubRecordsView) and into
    // `iconForType(pointer)`, so a desk-only type name fails twice over: the list
    // 422s ("Unknown entity type") AND the icon falls back to the generic glyph,
    // because a type the hub has no registry entry for has no icon either. That
    // is what retired the `flows` entry: its `graph_workflow` is desk-only, and
    // the hub's own flow type is `agentic_flow`.
    const pointers = Object.fromEntries(
      buildHubRailItems(t, 'proj-1')
        .filter((i) => i.viewType === ViewType.HUB_RECORDS)
        .map((i) => [i.id, i.pointer]),
    );

    expect(pointers).toEqual({
      inbox: 'conversation',
      tasks: 'task',
      docs: 'markdown',
    });
  });

  it('sends Organization to the plain screen, not to a graph projection', () => {
    // Both used to be WorldView entries separated only by their pointer, which put
    // a force-directed graph in front of anyone who just wanted to add someone to a
    // team. The graph is still there — reachable from inside the page — but the
    // rail now opens the master-detail screen.
    const items = buildHubRailItems(t);

    expect(items.find((i) => i.id === 'world')?.pointer).toBe(WorldViewProjection.WORLD);

    const organization = items.find((i) => i.id === 'organization');
    expect(organization?.viewType).toBe(ViewType.ORGANIZATION);
    expect(organization?.pointer).toBeUndefined();
  });

  it('opens the Token plan view with no pointer, just before LLM Endpoints', () => {
    const items = buildHubRailItems(t);
    const idx = items.findIndex((i) => i.id === 'token-plan');

    expect(items[idx]?.viewType).toBe(ViewType.TOKEN_PLAN);
    expect(items[idx]?.pointer).toBeUndefined();
    expect(items[idx + 1]?.id).toBe('llm-endpoints');
  });

  it('opens the LLM Endpoints view with no pointer, just before Credentials', () => {
    const items = buildHubRailItems(t);
    const idx = items.findIndex((i) => i.id === 'llm-endpoints');

    expect(items[idx]?.viewType).toBe(ViewType.LLM_ENDPOINTS);
    expect(items[idx]?.pointer).toBeUndefined();
    expect(items[idx + 1]?.id).toBe('credentials');
  });

  it('never leaks the hub-only ids into the desk rail', () => {
    // The two unions overlap where a destination genuinely exists on both rails —
    // 'home', 'inbox', and now 'credentials', which took a desk slot under the
    // inbox and has its own entry in the desk `navMeta`. What must stay out is an
    // id with no desk entry behind it: that renders a silent `null` slot.
    // `llm-endpoints` and `token-plan` are hub-only and have no desk screen.
    expect(RAIL_ITEMS.map((i) => i.id as string)).not.toContain('llm-endpoints');
    expect(RAIL_ITEMS.map((i) => i.id as string)).not.toContain('token-plan');
  });
});

it('does not put LLM sources on the hub rail', () => {
  // Every fact that page renders is a box fact (a device token, a stored key, the endpoint
  // binding) and its box action 404s on the hub, so a hub entry would open an empty shell —
  // the failure `buildHubRailItems` documents for InboxView.
  const ids = buildHubRailItems(((s: TemplateStringsArray) => s[0]) as never).map((i) => i.id);
  expect(ids).not.toContain('llm-sources');
});
