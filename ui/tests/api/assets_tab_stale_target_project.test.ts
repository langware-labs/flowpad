/**
 * The ONE scope-keyed Assets tab must follow the asset its URL names.
 *
 * The proven production failure (RCA 2026-09-09, "no active tab" on
 * /dock/assets/editor/html/vfs/<cn>/…/gtm-weekly-tracker.html): `ViewType.ASSETS`
 * is `scopeKeyed`, so every asset opened in the Assets browser shares ONE Tab row
 * (`tabHash === "assets|all"`). The row carries the denormalized target of
 * whichever asset was opened in it first — in prod, an `agent` living in the
 * Flowpad Assistant project. `materializeTab` (ui/src/tabs/tab-content-lifecycle.ts)
 * then reuses that row VERBATIM: its self-heal fires only for project-LESS content
 * tabs (`existingTab.project_id || !isContentAssetDock(dock)`), so a row already
 * stamped with a project never re-derives, and the target is never re-pointed.
 * The backend re-derived `project_id` from that stale target on every list read
 * (`_resolve_tab_projects`, flow_sdk/builtin/tab.py), and the strip renders
 * `topLevelTabsForProject(tabs, activeProject)` — so with no project active the
 * chip the loader just activated is filtered out of the strip: no active tab.
 *
 * Invariant under test: after loading a PROJECTLESS asset, the Assets tab's
 * `project_id` is null and the row appears in the Global scope the strip reads.
 *
 * Everything is real — real Project/Markdown rows, a real .html file outside every
 * project mount (a file-only editor: no entity to inherit a project from), and the
 * real UI load path (`setupTab` → `materializeTab`). No mocks, no hand-forced rows.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Markdown, Project, Tab, dataManager, tabManager } from '@sdk';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { setupTab } from '@src/tabs/tab-content-lifecycle';
import { trackForCleanup } from '../_cleanup';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

// A no-op content adapter so `setupTab` exercises ONLY the materialize path
// (tab create/resolve), not any view-specific editor side effects.
const noopAdapter = {
  setupTab: async () => ({ tab: null as Tab | null }),
  cleanupTab: async () => {},
};

describe('the scope-keyed Assets tab follows the asset its URL names', () => {
  const signupInfo = getTestSignupInfo();

  const tmpDirs: string[] = [];

  beforeEach(async (context: any) => {
    await apiTestSetup(signupInfo, context.task.name);
  });

  afterAll(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a projectless asset does not leave the Assets chip pinned to the previous asset project', async () => {
    // ── Phase 1: open an asset that LIVES IN a project. This mints the single
    // scope-keyed Assets row and stamps it with that project — exactly how prod's
    // row came to carry the `cloud-error-fixer` agent's project.
    const project = trackForCleanup(await new Project({ name: `/tmp/flow_assets_tab_${Date.now()}` }).save([]));
    const md = trackForCleanup(await new Markdown({ name: 'in-project-doc', project_id: project.id }).save([]));

    const inProject = DockPointer.forAssetEditorByTypeId(Markdown.type, md.typeId);
    expect(inProject.tabHash).toBe('assets|all');
    // Before the fix this row was stamped with `project` here, from the target
    // — the stale state phase 2 inherited. Not asserted: it is the defect, not
    // the setup contract.
    const first = await setupTab(inProject, { adapter: noopAdapter });
    expect(first.tab).toBeTruthy();

    // ── Phase 2: navigate to a PROJECTLESS asset — a real .html file outside every
    // project mount. `html` is a file-only editor, so there is no entity and no
    // project to inherit: this tab belongs in the Global scope.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-assets-'));
    tmpDirs.push(tmpDir);
    const htmlPath = path.join(tmpDir, 'report.html');
    fs.writeFileSync(htmlPath, '<h1>tracker</h1>');
    const htmlDock = DockPointer.forAssetEditor('html', htmlPath);
    // Same row by design — that is what makes the stale stamp reachable at all.
    expect(htmlDock.tabHash).toBe(inProject.tabHash);
    await dataManager.clearCache(); // fresh target resolution, like a page reload
    // A page RELOAD is how the failure was observed: the in-memory lifecycle map
    // starts empty, so the loader goes through `materializeTab` (not the
    // presentation-morph skip) — the same entry the instrumented prod run took.
    tabManager.lifecycle.resetForTests();

    await setupTab(htmlDock, { adapter: noopAdapter });

    // ── The invariant the tab strip depends on. Today materializeTab reuses the
    // project-stamped row verbatim, so the chip stays on the previous asset's
    // project and the Global strip — the one rendered when no project is active —
    // never contains it: the "no active tab" mechanism.
    const row = (await Tab.list(null)).find((tab) => tab.getKey() === 'assets|all');
    expect(row).toBeTruthy();
    expect(row?.project_id).toBeNull();
  }, 15000);

  it('an assets tab scoped to ONE project still belongs to that project', async () => {
    // The other half of the same rule: a scope-keyed tab's project IS its scope,
    // so a `scope-mode: project` Assets tab must stay attached to that project —
    // the fix must not simply make every assets tab Global.
    const project = trackForCleanup(await new Project({ name: `/tmp/flow_assets_scope_${Date.now()}` }).save([]));
    const dock = DockPointer.forAssetList('markdown', {
      scope: { mode: 'project', activeProjectId: project.id },
    });
    expect(dock.tabHash).toBe(`assets|project:${project.id}`);

    const { tab } = await setupTab(dock, { adapter: noopAdapter });
    expect(tab?.project_id).toBe(project.id);
    // Re-read: the backend's scope branch must not clobber the stamp the client wrote.
    const scopedKeys = (await Tab.list(project.id)).map((row) => row.getKey());
    expect(scopedKeys).toContain(`assets|project:${project.id}`);
  }, 15000);
});
