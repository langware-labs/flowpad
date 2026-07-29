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
 *   2. Dead-URL reap (`_reap_orphans` pointer arm): a project-scoped URL whose
 *      leading project id does NOT exist never keeps a tab — the row is removed
 *      on the next list rather than healed half-way (project_id healed from the
 *      target while the dead id stays fossilized in the pointer, which made the
 *      chip route into "Project not found" forever — RCA 2026-07-08).
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
import { dockForProjectEntry } from '@src/tabs/project-entry';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

// A no-op content adapter so `setupTab` exercises ONLY the materialize path
// (tab create/resolve), not any view-specific editor side effects.
const noopAdapter = {
  setupTab: async () => ({ tab: null as Tab | null }),
  cleanupTab: async () => {},
};

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

    // Cold load: target unresolvable, but the URL declares p1 → tab adopts p1.
    const result = await setupTab(dock, { adapter: noopAdapter });
    expect(result.error).toBeUndefined();
    expect(result.tab).toMatchObject({
      project_id: p1.id,
      target_type: 'markdown',
      target_id: mdId,
    });
    expect(result.tab?.pointer).toContain(p1.id);

    const persisted = (await Tab.listAll()).filter((tab) => tab.dockPointer?.tabHash === dock.tabHash);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].id).toBe(result.tab!.id);
    expect(persisted[0].project_id).toBe(p1.id);
  }, 15000);

  it('a URL naming a non-existent project persists no tab, even before the target exists', async () => {
    // Old contract: such a tab was born project-less and healed its project_id
    // from the target on a later load — leaving the DEAD project id fossilized
    // in Tab.pointer forever (RCA 2026-07-08). New contract: a tab addressing a
    // non-existent project is never kept — the dead-URL reap removes it on the
    // next list, whether or not its target exists yet.
    const mdId = uuidv4();
    const ghostProjectId = uuidv4();
    const dock = new DockPointer(
      ViewType.PROJECT,
      `${ghostProjectId}/editor/markdown/typeid/markdown-${mdId}`,
    );

    // Load through the real UI path. Materialization may fail outright (the
    // reap can drop the row within the same request) — either way, nothing may
    // persist.
    await setupTab(dock, { adapter: noopAdapter }).catch(() => null);
    expect(
      (await Tab.listAll()).filter((t) => t.pointer?.includes(ghostProjectId)),
    ).toEqual([]);

    // The target coming into existence later must NOT resurrect the dead URL:
    // reloading the same dock still persists nothing.
    const p1 = await new Project({ name: '/tmp/flow_tab_heal_p1' }).save([]);
    const md = await new Markdown({ id: mdId, name: `heal-${mdId}`, project_id: p1.id }).save([]);
    expect(md.project_id).toBe(p1.id);
    await dataManager.clearCache(); // force a fresh target fetch on reload

    await setupTab(dock, { adapter: noopAdapter }).catch(() => null);
    expect(
      (await Tab.listAll()).filter((t) => t.pointer?.includes(ghostProjectId)),
    ).toEqual([]);
  }, 15000);

  it('a dock URL naming a NON-EXISTENT project leaves no tab behind and never re-routes into the dead URL', async () => {
    // The proven production failure (RCA 2026-07-08): a tab opened under a dead
    // project id survives forever — the heal re-stamps its project_id from the
    // target, but the DEAD id stays baked into Tab.pointer. The chip then
    // advertises the healed project, and entering that project resolves the
    // stale tab's pointer verbatim → /dock/project/<dead>/… → "Project not
    // found", every time. Contract under test: a load against a non-existent
    // project must CLEAN UP — no persisted tab may keep addressing the dead
    // project, and the project-entry resolver must never return its URL.
    const p1 = await new Project({ name: '/tmp/flow_tab_heal_p1' }).save([]);
    const mdId = uuidv4();
    const md = await new Markdown({ id: mdId, name: `heal-${mdId}`, project_id: p1.id }).save([]);
    expect(md.project_id).toBe(p1.id);

    const ghostProjectId = uuidv4();
    const dock = new DockPointer(
      ViewType.PROJECT,
      `${ghostProjectId}/editor/markdown/typeid/markdown-${mdId}`,
    );

    // Real UI load path. The project route itself may reject (the project is
    // genuinely gone — a "Project not found" surface is correct); the tab
    // lifecycle outcome is what's under test.
    await setupTab(dock, { adapter: noopAdapter }).catch(() => null);

    // (1) Tabs are removed/cleaned: no persisted tab still addresses the dead
    // project. Today this fails — the materialized tab survives with the ghost
    // id baked into its pointer.
    const leftovers = (await Tab.listAll()).filter((t) => t.pointer?.includes(ghostProjectId));
    expect(leftovers.map((t) => ({ id: t.id, pointer: t.pointer }))).toEqual([]);

    // (2) Nothing routes back into the dead URL: entering the healed project
    // (the chip's click path) must never resolve a pointer that names the
    // non-existent project.
    const entry = await dockForProjectEntry(p1.id);
    expect(entry?.pointer ?? '').not.toContain(ghostProjectId);
  }, 15000);
});
