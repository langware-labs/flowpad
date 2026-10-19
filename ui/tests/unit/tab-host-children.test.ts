// Frontend half of the host-tab child contract (tests/fixtures/tab_host_children.json).
// The backend twin is tests/unit/test_tab_host_children.py; together they keep
// `navigation/tab-hosts.ts` and `_HOST_CHILD_RULES` (tab.py) from drifting apart.
import { describe, expect, it } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { isHostDock, tabHostFor } from '@src/navigation/tab-hosts';
import { ViewType, VIEWER_REGISTRY } from '@src/types/ViewType';
import fixture from '../../../tests/fixtures/tab_host_children.json';

type Case = { name: string; url: string; user: boolean; shown: boolean; backend: boolean; stored?: string };
const hosts = fixture.hosts as Record<string, Case[]>;

describe('host tabs', () => {
  it('every registry host is in the fixture, and only those', () => {
    const registryHosts = Object.entries(VIEWER_REGISTRY)
      .filter(([, meta]) => meta?.hostsTabs)
      .map(([vt]) => vt);
    expect(registryHosts.sort()).toEqual(Object.keys(hosts).sort());
  });

  for (const [hostViewType, cases] of Object.entries(hosts)) {
    const host = tabHostFor(hostViewType as ViewType)!;
    for (const c of cases) {
      it(`${hostViewType}: ${c.name}`, () => {
        const dock = DockPointer.fromUrl(c.url);
        expect(host.accepts(dock)).toBe(c.user);
        expect(host.accepts(dock, { shown: true })).toBe(c.shown);
        // The backend judges the pointer the URL STORES — pin that it is this one.
        expect(dock.toJSON()).toBe(c.stored);
      });
    }
  }

  it('a host dock is itself a host, a child is not', () => {
    expect(isHostDock(DockPointer.fromUrl('/dock/vibe/agentic_process-550e8400-e29b-41d4-a716-446655440000'))).toBe(true);
    expect(isHostDock(DockPointer.fromUrl('/dock/shell/agentic_process-550e8400-e29b-41d4-a716-446655440000'))).toBe(false);
  });
});
