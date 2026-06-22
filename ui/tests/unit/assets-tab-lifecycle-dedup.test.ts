/**
 * The payoff of scope-keyed assets identity: switching the menu (skill → agent)
 * WITHIN one scope reuses the single materialized tab (no `getFromDockPointer`,
 * no new row), while switching SCOPE materializes a distinct tab. Exercises the
 * real `setupTab` → `materializeTab` → `findTabForDock` path with a stateful
 * in-memory Tab store (seed rows use `dock.toJSON()`, so dedup runs through the
 * actual `Tab.dockPointer` reconstruction).
 */
import { Tab } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { resetTabLifecycleForTests, setupTab } from '@src/tabs/tab-lifecycle';
import { type ScopeFilter } from '@src/lib/scope-filter';
import { afterEach, describe, expect, it, vi } from 'vitest';

const A: ScopeFilter = { user: false, projects: ['A'] };
const B: ScopeFilter = { user: false, projects: ['B'] };

let tabIdCounter = 0;
function nextTabId(): string {
  tabIdCounter += 1;
  return `00000000-0000-4000-8000-${String(tabIdCounter).padStart(12, '0')}`;
}

/** Wire a stateful Tab store: getFromDockPointer mints+stores; listAll reads it. */
function mockTabStore() {
  const store: Tab[] = [];
  vi.spyOn(Tab, 'listAll').mockImplementation(async () => [...store]);
  const getSpy = vi.spyOn(Tab, 'getFromDockPointer').mockImplementation(async (d) => {
    const t = new Tab({ id: nextTabId(), pointer: d.toJSON?.() ?? '', visible: true });
    store.push(t);
    return [t];
  });
  return { store, getSpy };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetTabLifecycleForTests();
});

describe('assets tab dedup by scope', () => {
  it('switching type within a scope reuses the same tab (no new row)', async () => {
    const { store, getSpy } = mockTabStore();

    await setupTab(DockPointer.forAssetList('skill', { scope: A }));
    await setupTab(DockPointer.forAssetList('agent', { scope: A }));

    expect(getSpy).toHaveBeenCalledTimes(1); // second nav found the existing tab
    expect(store).toHaveLength(1);
  });

  it('switching scope materializes a distinct tab', async () => {
    const { store, getSpy } = mockTabStore();

    await setupTab(DockPointer.forAssetList('skill', { scope: A }));
    await setupTab(DockPointer.forAssetList('skill', { scope: B }));

    expect(getSpy).toHaveBeenCalledTimes(2);
    expect(store).toHaveLength(2);
    expect(store[0].dockPointer?.tabHash).toBe('assets|0:A');
    expect(store[1].dockPointer?.tabHash).toBe('assets|0:B');
  });
});
