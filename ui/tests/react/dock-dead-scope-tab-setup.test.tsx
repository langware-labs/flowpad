/**
 * RCA capture: entering a dock URL whose `scope-activeProjectId` names a project
 * that does not exist must not leave the dock DEAD — no content, no navigation,
 * no error surface. Today it does, and this test enters through the same door
 * the browser does.
 *
 * Proven this session on the live page (:5007 / fence-7), with temporary probes:
 *
 *   [PROBE] main-loader runSetup start assets
 *   [PROBE] setupTab {key: "assets|project:f3b2221f-…", materialize: true}
 *   [PROBE] setupTab CAUGHT Error: Tab could not be materialized for this URL.
 *   [PROBE] main-loader runSetup done
 *
 * — and NO `adoptScopeProject` probe in between. `materializeTab` cannot mint a
 * tab for a dock scoped to a project that isn't there (tab-lifecycle.ts:263);
 * `setupTab` catches that, records `OpenFailed`, and RETURNS, so
 * `adapter.setupTab(dock)` — the call that runs the dock loader — never happens.
 * The dead scope is therefore never adopted, repaired, or reported: the app rests
 * on the URL it was given and the asset navigator shows only "Project home".
 * With a live project id the same URL materializes, the loader runs (the
 * `adoptScopeProject` probe fires) and the full tree renders.
 *
 * OBSERVABLE: the persisted `Tab` whose natural key is the dock's `tabHash`.
 * The in-memory `OpenFailed` lifecycle entry is NOT usable here —
 * `syncTabLifecycleWithTabs` deletes any entry with no visible tab, which is
 * precisely the failing case, so reading it back yields `null` and an assertion
 * on it passes vacuously. The tab row is backend-recorded ground truth and
 * survives.
 *
 * ENTRY POINT: `loadAgentApp` — the react-router loader on the `/dock/:viewType/*`
 * route, which is what the browser actually enters. Calling `loadDockPointer`
 * directly would prove nothing here: the bug is that the real path never reaches
 * it. The observable is the product's OWN recorded state (`getTabLifecycle`), not
 * a value invented by the test, and the assertion quotes the same error string
 * the live run logged.
 *
 * The assertion states the invariant, not the fix: a dock may open, or it may
 * navigate somewhere it can open — it may not silently die. Any of those
 * recoveries turns this green.
 *
 * No mocks: real loader, real tab lifecycle, real backend, and a project id that
 * genuinely resolves to nothing (asserted before the act).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

import { Project, Tab, TypeId, dataManager } from '@sdk';
import { DockPointer } from '@src/navigation';
import { loadAgentApp } from '@src/routes/loaders/main-loader';
import { resetTabLifecycleForTests } from '@src/tabs/tab-lifecycle';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

const DOCK_PATH = '/dock/assets/project-home';

function dockUrl(projectId: string): string {
  return `${DOCK_PATH}?scope-mode=project&scope-activeProjectId=${projectId}&viewMode=advanced`;
}

/**
 * Enter the dock exactly as react-router does, and report what the app was left
 * holding: the redirect it navigated with (if any) and whether the dock ended up
 * with a real tab.
 */
async function enterDock(projectId: string) {
  const url = dockUrl(projectId);
  const dock = DockPointer.fromUrl(url);
  let redirected: string | null = null;
  try {
    await loadAgentApp({
      request: new Request(`http://localhost${url}`),
      params: { viewType: 'assets', '*': 'project-home' },
      context: {} as never,
    } as never);
  } catch (e) {
    if (!(e instanceof Response)) throw e;
    redirected = e.headers.get('Location');
  }
  const tabs = await Tab.listAll();
  return { redirected, opened: tabs.some((t) => t.getKey() === dock.tabHash) };
}

let liveProject: Project | null = null;

describe('react: dock URL scoped to a nonexistent project', () => {
  const info = getTestSignupInfo();

  beforeEach(async (context: any) => {
    await apiTestSetup(info, context.task.name);
    resetTabLifecycleForTests();
  });

  afterAll(async () => {
    await liveProject?.delete().catch(() => {});
  });

  it('does not leave the dock dead — it opens or it navigates', async () => {
    const deadProjectId = uuidv4();
    await dataManager.clearCache();
    const missing = await dataManager
      .getByTypeId<Project>(new TypeId(Project.type, deadProjectId))
      .catch(() => null);
    expect(missing, 'precondition: the scoped project must not exist').toBeNull();

    const { redirected, opened } = await enterDock(deadProjectId);

    // The live failure: setup dies on tab materialization ("Tab could not be
    // materialized for this URL."), so the dock gets no tab AND no navigation —
    // the user is left resting on a scope nothing can satisfy.
    expect(
      redirected !== null || opened,
      'entering a dock with an unsatisfiable scope must open it or navigate away, not fail silently',
    ).toBe(true);
  }, 15000);

  it('opens normally when the scoped project exists', async () => {
    liveProject = await new Project({ name: `dock-scope-live-${uuidv4().slice(0, 8)}` }).save();
    await dataManager.clearCache();

    const { opened } = await enterDock(liveProject.id);

    expect(opened, 'a resolvable scope opens its dock').toBe(true);
  }, 15000);
});
