/**
 * A content tab born project-less must heal its project_id on the next load
 * (RCA capture).
 *
 * Invariant: a content tab's `project_id` == its target entity's `project_id`.
 *
 * The real bug: when a tab is materialized while its target is not yet
 * resolvable (a vfs/typeid asset that isn't indexed/created yet),
 * `getFromDockPointer` resolves `project_id = null` and the tab is persisted
 * project-less (the 42 vfs asset tabs, e.g. the rca skill tab). The backend
 * record→tab sync only re-derives a tab's project when the TARGET ENTITY
 * CHANGES projects — so a tab born null whose target never moves is never
 * healed there. And the UI load path `setupTab` → `materializeTab`
 * short-circuits: an already-existing tab (Tab.listAll match) is returned
 * VERBATIM and `getFromDockPointer` (the resolve step) is never called again.
 * Net result: the tab stays null forever (the blue/project-less symptom).
 *
 * This drives the REAL load path against the REAL backend (no mocks):
 *   load tab before target exists  → tab.project_id == null   (born project-less)
 *   create target (project P1)     → load tab again → tab.project_id == P1
 * The final assertion FAILS today (the reloaded tab keeps null). It passes once
 * materializeTab re-resolves `tab.project_id` from the target on every load.
 *
 * Note: the target is CREATED, not moved between projects — so the backend's
 * change-driven tab heal never fires; only the UI re-resolve could fix it.
 */
import { Markdown, Project, Tab, dataManager } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import { setupTab } from '@src/tabs/tab-lifecycle';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

// A no-op content adapter so `setupTab` exercises ONLY the materialize path
// (tab create/resolve), not any view-specific editor side effects.
const noopAdapter = {
  setupTab: async () => ({ tab: null as Tab | null }),
  cleanupTab: async () => {},
};

/** Run the real UI load path and return the resulting tab's project_id. */
async function loadTabProjectId(dock: DockPointer): Promise<string | null> {
  const { tab } = await setupTab(dock, { adapter: noopAdapter });
  expect(tab).toBeTruthy();
  return tab!.project_id ?? null;
}

describe('a project-less content tab heals from its target on the next load', () => {
  const signupInfo = getTestSignupInfo();

  beforeEach(async (context: any) => {
    await apiTestSetup(signupInfo, context.task.name);
  });

  it('reloading a tab born project-less adopts its target entity project', async () => {
    const p1 = await new Project({ name: '/tmp/flow_tab_heal_p1' }).save([]);

    // A target id that does NOT exist yet — so first materialize resolves no
    // entity and the tab is born project-less (the real null-birth condition).
    const mdId = uuidv4();
    const dock = new DockPointer(
      ViewType.PROJECT,
      `${p1.id}/editor/markdown/typeid/markdown-${mdId}`,
    );

    // First load: no target entity → tab persisted with project_id == null.
    expect(await loadTabProjectId(dock)).toBeNull();

    // The target now exists, owned by P1. This is a fresh CREATE (no existing
    // entity changes project), so the backend's change-driven tab heal never
    // fires — only a UI re-resolve on load could correct the tab.
    const md = await new Markdown({ id: mdId, name: `heal-${mdId}`, project_id: p1.id }).save([]);
    expect(md.project_id).toBe(p1.id);
    await dataManager.clearCache(); // force a fresh target fetch on reload

    // Second load (same dock): the tab must now adopt the target's project.
    expect(await loadTabProjectId(dock)).toBe(p1.id);
  }, 15000);
});
