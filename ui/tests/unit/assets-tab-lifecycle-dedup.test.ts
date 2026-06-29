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
import { projectScope, type ScopeFilter } from '@src/lib/scope-filter';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Single-project ("active project") scopes. Ids must be valid entity ids (UUID
// v4/v5) so they survive the dock-options encode/decode that `tabHash` reads —
// `SCOPE_CODEC` drops a foreign id from a `project` scope.
const PROJECT_A = '00000000-0000-4000-8000-00000000000a';
const PROJECT_B = '00000000-0000-4000-8000-00000000000b';
const A: ScopeFilter = projectScope(PROJECT_A);
const B: ScopeFilter = projectScope(PROJECT_B);

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
    expect(store[0].dockPointer?.tabHash).toBe(`assets|project:${PROJECT_A}`);
    expect(store[1].dockPointer?.tabHash).toBe(`assets|project:${PROJECT_B}`);
  });
});
