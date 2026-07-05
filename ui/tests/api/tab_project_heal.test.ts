/**
 * A content tab's `project_id` must equal its target entity's project — and,
 * when the target isn't yet resolvable, must still be correct rather than
 * stranded project-less forever (RCA capture: the 42 vfs asset tabs that "stayed
 * blue").
 *
 * Invariant: a content tab's `project_id` == its target entity's `project_id`.
 *
 * There are now TWO server-side mechanisms that keep this invariant even when the
 * tab is materialized before its target exists (see `_backfill_tab_projects` in
 * flow_sdk/builtin/tab.py, run on every `list`/`list_all`):
 *
 *   1. URL-authority backfill (`_project_from_pointer`): a PROJECT-SCOPED dock
 *      URL `/dock/project/<pid>/…` declares its project directly. A content tab
 *      opened under such a URL adopts `<pid>` on the very first load even when
 *      its target row is missing/unindexed — the URL itself is the authority.
 *      So a tab whose URL names an existing project is NEVER born project-less.
 *      (This is what made the old "born null on first load" assertion stale.)
 *
 *   2. Target-driven heal (`_project_of_target`): a tab whose URL does NOT name a
 *      resolvable project is born project-less, then heals to its target's
 *      project on the next load once the target exists. This is the original
 *      never-heals bug's fix, and the `materializeTab` reuse path deliberately
 *      falls through to re-resolve a project-less content tab rather than
 *      returning it verbatim.
 *
 * Both are driven against the REAL backend (no mocks) through the REAL UI load
 * path (`setupTab` → `materializeTab`).
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

describe('a content tab keeps its project_id == its target entity project', () => {
  const signupInfo = getTestSignupInfo();

  beforeEach(async (context: any) => {
    await apiTestSetup(signupInfo, context.task.name);
  });

  it('a project-scoped URL adopts its declared project immediately, before the target exists', async () => {
    const p1 = await new Project({ name: '/tmp/flow_tab_heal_p1' }).save([]);

    // The URL names an EXISTING project (p1) but targets a markdown that does not
    // exist yet. URL-authority backfill stamps p1 on the first load — the tab is
    // NOT born project-less.
    const mdId = uuidv4();
    const dock = new DockPointer(
      ViewType.PROJECT,
      `${p1.id}/editor/markdown/typeid/markdown-${mdId}`,
    );

    // First load: target unresolvable, but the URL declares p1 → tab adopts p1.
    expect(await loadTabProjectId(dock)).toBe(p1.id);

    // Create the target owned by p1; the tab still resolves p1 — now confirmed by
    // the target itself, agreeing with the URL. Invariant holds on both loads.
    const md = await new Markdown({ id: mdId, name: `heal-${mdId}`, project_id: p1.id }).save([]);
    expect(md.project_id).toBe(p1.id);
    await dataManager.clearCache(); // force a fresh target fetch on reload

    expect(await loadTabProjectId(dock)).toBe(p1.id);
  }, 15000);

  it('a tab born project-less (URL names no resolvable project) heals from its target on the next load', async () => {
    const p1 = await new Project({ name: '/tmp/flow_tab_heal_p1' }).save([]);

    // The URL's leading segment is a project id that does NOT exist, and the
    // target markdown does not exist yet — so neither backfill mechanism can
    // resolve a project and the tab is genuinely born project-less.
    const mdId = uuidv4();
    const ghostProjectId = uuidv4();
    const dock = new DockPointer(
      ViewType.PROJECT,
      `${ghostProjectId}/editor/markdown/typeid/markdown-${mdId}`,
    );

    // First load: no resolvable project anywhere → tab persisted project_id null.
    expect(await loadTabProjectId(dock)).toBeNull();

    // The target now exists, owned by P1 (a fresh CREATE — the backend's
    // change-driven reconcile never fires; only a UI re-resolve on load could
    // correct the tab). `materializeTab` re-resolves a project-less content tab
    // rather than reusing it verbatim, so the reloaded tab adopts p1.
    const md = await new Markdown({ id: mdId, name: `heal-${mdId}`, project_id: p1.id }).save([]);
    expect(md.project_id).toBe(p1.id);
    await dataManager.clearCache(); // force a fresh target fetch on reload

    // Second load (same dock): the tab must now adopt the target's project.
    expect(await loadTabProjectId(dock)).toBe(p1.id);
  }, 15000);
});
