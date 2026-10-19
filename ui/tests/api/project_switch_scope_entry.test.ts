/**
 * Project switching must ADOPT the destination project — RCA regression
 * (2026-07-15, the "stuck footer" switch bug).
 *
 * Proven root cause: entering a project resolves its "best" tab and trusts the
 * landing dock's LOADER to write `CurrentProjectTypeId` (URL-first). A
 * scope-keyed browse tab (e.g. "<project>'s Assets", pointer folded to '' with
 * the project only in its scope options) landed on `loadAssetRoute('')` — a
 * context no-op — so `dataContext.project` silently stayed on the PREVIOUS
 * project. Whether the bug fired was pure tab data: the browse tab was only
 * pickable when born with a target (opened a doc), and only won when no
 * recency-stamped tab existed (browse tabs were never stamped) via the
 * tab_order guess.
 *
 * Contracts under test (all against the REAL backend, real UI load path):
 *   1. Landing on a project-pinned assets dock adopts that project into
 *      context (`adoptScopeProject` in load-dock-pointer.ts).
 *   2. Scope entry only trusts a KNOWN last tab (recency-stamped); with no
 *      stamp anywhere it falls back to the project landing — never the
 *      tab_order guess that used to surface an unstamped browse tab.
 *   3. With no known tab and a scope-keyed CURRENT view, entry re-scopes that
 *      view to the destination project (switching from Assets stays on Assets).
 */
import { ContextEntitiesEnum, dataContext, Markdown, Project, Tab, TypeId } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { trackForCleanup } from '../_cleanup';
import { v4 as uuidv4 } from 'uuid';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import { projectScope } from '@src/lib/scope-filter';
import { setupTab } from '@src/tabs/tab-content-lifecycle';
import { dockForProjectEntry } from '@src/tabs/project-entry';
import { loadDockPointer } from '@src/routes/loaders/load-dock-pointer';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

// A no-op content adapter so `setupTab` exercises ONLY the materialize path
// (tab create/resolve), not any view-specific editor side effects.
const noopAdapter = {
  setupTab: () => Promise.resolve({ tab: null as Tab | null }),
  cleanupTab: () => Promise.resolve(),
};

/** An assets EDITOR dock for `md`, scope-pinned to `projectId` — the shape that
 *  births a "<project>'s Assets" tab WITH a target (the pickable poison state). */
function assetsEditorDock(projectId: string, mdId: string): DockPointer {
  return new DockPointer(ViewType.ASSETS, `editor/markdown/typeid/markdown-${mdId}`).withScopeFilter(
    projectScope(projectId),
  );
}

async function setCurrentProject(projectId: string): Promise<void> {
  await dataContext.setContextEntityTypeId(
    ContextEntitiesEnum.CurrentProjectTypeId,
    new TypeId(Project.type, projectId),
  );
}

/** Navigate the way the app does: entry dock → URL → parsed dock → loader. */
async function loadEntryLikeTheRouter(entry: DockPointer): Promise<void> {
  const url = new DockPointer(entry).toUrl();
  const parsed = DockPointer.fromUrl(url);
  await loadDockPointer(parsed, { requestPath: url.split('?')[0] });
}

describe('project switch scope entry adopts the destination project', () => {
  const signupInfo = getTestSignupInfo();

  beforeEach(async (context) => {
    await apiTestSetup(signupInfo, context.task.name);
  });

  it('landing on a project-pinned assets tab (the known last tab) switches the active project', async () => {
    const p = trackForCleanup(await new Project({ name: `/tmp/flow_switch_p_${uuidv4()}` }).save([]));
    const q = trackForCleanup(await new Project({ name: `/tmp/flow_switch_q_${uuidv4()}` }).save([]));

    // P's only tab: a scope-keyed assets tab BORN from a doc-open (target
    // stamped → pickable) — the exact poison state from the RCA.
    const md = await new Markdown({ id: uuidv4(), name: `switch-${p.id}`, project_id: p.id }).save([]);
    const { tab } = await setupTab(assetsEditorDock(p.id, md.id), { adapter: noopAdapter });
    expect(tab).toBeTruthy();
    expect(tab!.project_id).toBe(p.id);
    // The lifecycle stamp is fire-and-forget; stamp explicitly so the assets
    // tab is deterministically P's KNOWN last tab for this test.
    await Tab.activateById(tab!.id);

    // We are "in" Q when the switch happens.
    await setCurrentProject(q.id);
    expect(dataContext.project?.id).toBe(q.id);

    // Switch to P: the known last tab wins — an assets (browse) landing.
    const entry = await dockForProjectEntry(p.id);
    expect(entry?.viewType).toBe(ViewType.ASSETS);

    // The landing's loader is the single writer of project context. Pre-fix
    // this was a no-op for a folded assets pointer and the project stayed Q.
    await loadEntryLikeTheRouter(entry);
    expect(dataContext.project?.id).toBe(p.id);
  }, 15000);

  it('with no recency-stamped tab, entry falls back to the project landing — never the tab_order guess', async () => {
    const p = trackForCleanup(await new Project({ name: `/tmp/flow_switch_ns_${uuidv4()}` }).save([]));
    const md = await new Markdown({ id: uuidv4(), name: `switch-${p.id}`, project_id: p.id }).save([]);

    // Materialize the assets tab WITHOUT the lifecycle (no recency stamp) —
    // the pre-fix state of every browse tab.
    await Tab.getFromDockPointer(assetsEditorDock(p.id, md.id));
    const tabs = (await Tab.listAll()).filter((t) => t.project_id === p.id);
    expect(tabs.length).toBeGreaterThan(0);
    expect(tabs.every((t) => t.last_active_at == null)).toBe(true);

    // Unknown last tab → project landing (which adopts P), not the unstamped
    // browse tab that tab_order used to surface.
    const entry = await dockForProjectEntry(p.id);
    expect(entry?.viewType).toBe(ViewType.PROJECT);
    expect(entry?.pointer).toBe(p.id);
  }, 15000);

  it('with no recency-stamped tab and a scope-keyed current view, entry re-scopes that view to the destination', async () => {
    const p = trackForCleanup(await new Project({ name: `/tmp/flow_switch_sk_${uuidv4()}` }).save([]));
    const q = trackForCleanup(await new Project({ name: `/tmp/flow_switch_sq_${uuidv4()}` }).save([]));

    // Switching from Q's Assets browser to (tab-less) P stays on Assets, scoped to P.
    const currentDock = new DockPointer(ViewType.ASSETS, '').withScopeFilter(projectScope(q.id));
    const entry = await dockForProjectEntry(p.id, currentDock);
    expect(entry?.viewType).toBe(ViewType.ASSETS);
    const scope = new DockPointer(entry).scopeFilter;
    expect(scope?.mode).toBe('project');
    expect(scope?.mode === 'project' ? scope.activeProjectId : null).toBe(p.id);

    // And loading that landing adopts P (rule 1's guarantee holds on this path too).
    await setCurrentProject(q.id);
    await loadEntryLikeTheRouter(entry);
    expect(dataContext.project?.id).toBe(p.id);
  }, 15000);
});
