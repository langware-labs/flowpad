/**
 * RCA capture (2026-10-13): a web page opened inside a project
 * (`/dock/web-app/url/<encoded>`, no scope params) fills the panel but no chip
 * in the tab strip is lit.
 *
 * The strip draws the ACTIVE PROJECT's tabs. A web URL dock has no target
 * entity, so its tab took a project only from the URL's scope params; a bare
 * URL minted the row with no project, the row landed in Global, and the strip
 * of the project the user is in had no chip to light.
 *
 * Enters where the route loader does (`setupTab`), and reads the `new_tab`
 * request the backend receives.
 */
import { dataManager, Project, Tab, tabManager } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { loadProjectRoute } from '@src/routes/loaders/load-project';
import { resetTabContentLifecycleForTests, setupTab } from '@src/tabs/tab-content-lifecycle';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const dock = DockPointer.forWebUrl('http://localhost:5005/');
const savedWithoutProject = new Tab({
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  pointer: dock.toJSON() ?? '',
  project_id: null,
  visible: true,
});

beforeEach(async () => {
  const project = new Project({ id: PID, name: 'demo', fs_storage_mount_path: '/work/demo' });
  project.markAsExpanded();
  await loadProjectRoute(DockPointer.forProject(PID).pointer);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetTabContentLifecycleForTests();
  tabManager.resetForTests();
});

describe('a web page opened inside a project', () => {
  it.each([
    ['mints its tab in that project', []],
    ['re-stamps a tab that was saved without a project', [savedWithoutProject]],
  ])('%s', async (_name, openTabs) => {
    vi.spyOn(Tab, 'listAll').mockResolvedValue(openTabs);
    let minted: { project_id?: string | null } | null = null;
    vi.spyOn(dataManager, 'callAction').mockImplementation((info: any) => {
      if (info?.name === 'new_tab') minted = info.bodyParameters;
      return Promise.resolve({ tabs: [] } as any);
    });

    await setupTab(dock);

    expect(minted).not.toBeNull();
    expect(minted!.project_id ?? null).toBe(PID);
  });
});
