/**
 * A project switch ALWAYS switches — through the REAL resolver and dispatcher
 * (docs/navigation/dock-loading.md).
 *
 * RCA 2026-10-09 (prod 0.2.200): switching to gtm-studio resumed its last tab,
 * the `gtm-pipeline` micro app. A stored tab pointer is identity only
 * (`{"viewType":"app","pointer":"micro_app-…"}`), so the resumed URL named no
 * project; the `app` view has no loader of its own, and `adoptScopeProject` on
 * an unscoped dock keeps whatever project is current. The app opened, the chip
 * stayed on the project the user left. Proven both ways on :9007: adding the
 * target's scope to the same URL switched; removing it did not.
 *
 * Contracts pinned here:
 *   1. a resumed context-neutral tab lands in the project being entered;
 *   2. a dock whose own loader FAILS still lands there — the failure renders
 *      inside the target project, never in the one being left.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sdk', async (orig) => ({ ...(await orig<typeof import('@sdk')>()), initSdk: vi.fn(async () => {}) }));

import { ComputeNode, ContextEntitiesEnum, dataContext, Project, tabManager, TypeId } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { getDockLoadError } from '@src/routes/loaders/dock-load-error-store';
import { dockForProjectEntry } from '@src/tabs/project-entry';
import { resetTabContentLifecycleForTests } from '@src/tabs/tab-content-lifecycle';
import { resetAgentAutoLaunchForTests } from '@src/agents/agent-auto-launch-redirect';
import { ViewType } from '@src/types/ViewType';
import { fakeTabStore, recordRequests, runDockLoader, seedBootstrap } from '../../utils/dock-loader-harness';

/** The project being left. */
const LEFT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
/** The project being entered (gtm-studio). */
const ENTERED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MICRO_APP = '9eb756fb-2e56-594f-9ed2-820e5dc552e9';
const GONE_PLAN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const projectList = () => [
  { type: 'project', id: LEFT, name: 'left', fs_storage_mount_path: '/w/left' },
  { type: 'project', id: ENTERED, name: 'entered', fs_storage_mount_path: '/w/entered' },
];

beforeEach(async () => {
  seedBootstrap({ default_compute_node: { type: ComputeNode.type, id: CN } });
  new ComputeNode({ id: CN, name: 'local' } as never).markAsExpanded();
  for (const p of projectList()) new Project(p as never).markAsExpanded();
  await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, new TypeId(Project.type, LEFT));
});

afterEach(() => {
  vi.restoreAllMocks();
  tabManager.resetForTests();
  resetTabContentLifecycleForTests();
  resetAgentAutoLaunchForTests();
});

/** Resume `pointer` as the entered project's last-active tab, and load where the switch lands. */
async function switchInto(pointer: DockPointer, target: { type: string; id: string }): Promise<DockPointer> {
  const tabs = fakeTabStore();
  tabs.rows.push({
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    pointer: pointer.toJSON() ?? '',
    target_type: target.type,
    target_id: target.id,
    project_id: ENTERED,
    name: 'resumed',
    visible: true,
    last_active_at: 1791472165903,
    tab_order: 0,
  });
  recordRequests([
    tabs,
    (req) => (req.method === 'GET' && req.path === '/graph/project' ? projectList() : undefined),
  ]);
  const dock = await dockForProjectEntry(ENTERED, DockPointer.forProject(LEFT));
  // The resumed tab itself — not the project-landing fallback, which adopts the project on its own.
  expect(dock.viewType).toBe(pointer.viewType);
  const outcome = await runDockLoader(dock.toUrl('/'));
  expect(outcome).toEqual({ outcome: 'ok' });
  return dock;
}

describe('project switch always lands in the entered project', () => {
  it('a resumed micro-app tab (no loader, no entity project) switches the project', async () => {
    await switchInto(new DockPointer(ViewType.APP, `micro_app-${MICRO_APP}`), { type: 'micro_app', id: MICRO_APP });

    expect(dataContext.project?.id).toBe(ENTERED);
  });

  it("a resumed tab whose own loader fails still switches — the error renders in the entered project", async () => {
    const dock = await switchInto(new DockPointer(ViewType.PLAN, `typeid/plan-${GONE_PLAN}`), {
      type: 'plan',
      id: GONE_PLAN,
    });

    expect(getDockLoadError(dock)?.kind).toBe('plan_not_found');
    expect(dataContext.project?.id).toBe(ENTERED);
  });
});
