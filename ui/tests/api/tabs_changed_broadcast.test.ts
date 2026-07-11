/**
 * tabs-changed reactivity contract (RCA: stale tab-strip chip).
 *
 * A terminal panel mirrors the PTY auto-title onto the Tab via `set_name`; the
 * backend persists it and fires `broadcast_tabs_changed()` — a WS message
 * `{message_type: "broadcast", broadcast_type: "tabs_changed"}` (tab.py). The
 * tab strip renders from the global store in `ui/src/tabs/all-tabs-store.ts`,
 * which refetches on that ping.
 *
 * This test drives the REAL consumer end-to-end over the real websocket: it
 * attaches the store's ping subscription, renames a real Tab through the real
 * `set_name` action, and asserts the store's snapshot picks up the new name
 * WITHOUT any local refresh. Before the fix it failed —
 * `ConnectionManager.onMessage` had no case for `message_type: 'broadcast'`,
 * so the ping was silently dropped and every chip stayed stale until some
 * other action happened to refetch the list (the reported "name only updates
 * when I open a new tab" bug).
 */

import { Tab } from '@sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { attachTabsChangedPing, getAllTabsSnapshot, refreshAllTabs } from '@src/tabs/all-tabs-store';
import { apiTestSetup } from '../utils/test-utils';

describe('tabs_changed broadcast drives the tab-strip store', () => {
  const marker = `e2etest-tabs-changed-${uuidv4().slice(0, 8)}`;
  const pointer = JSON.stringify({ viewType: 'assets', pointer: marker });
  let tabId: string | null = null;

  beforeAll(async () => {
    await apiTestSetup();
    const rows = await Tab.newTab(pointer, { name: marker });
    tabId = rows.find((t) => t.pointer === pointer)?.id ?? null;
    expect(tabId).toBeTruthy();
  });

  afterAll(async () => {
    if (tabId) await Tab.closeById(tabId).catch(() => {});
  });

  it('updates the store snapshot after a backend set_name, with no local refetch', async () => {
    attachTabsChangedPing();
    await refreshAllTabs(); // seed the snapshot with the pre-rename name
    expect(getAllTabsSnapshot().find((t) => t.id === tabId)?.name).toBe(marker);

    const newName = `${marker}-renamed`;
    await Tab.setNameById(tabId!, newName);

    // Ground truth: the backend applied the mutation (so the broadcast fired).
    const tabs = await Tab.listAll();
    expect(tabs.find((t) => t.id === tabId)?.name).toBe(newName);

    // The contract under test: the ping alone must refresh the store.
    await vi.waitFor(
      () => expect(getAllTabsSnapshot().find((t) => t.id === tabId)?.name).toBe(newName),
      { timeout: 3000, interval: 100 },
    );
  });
});
