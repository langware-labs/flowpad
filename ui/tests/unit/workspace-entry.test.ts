import { afterEach, expect, it, vi } from 'vitest';
import { tabManager } from '@sdk';
import { DockPointer, WORKSPACE_ENTRY_PARAM, WORKSPACE_PARAM } from '@src/navigation/DockPointer';
import { workspaceEntryDock } from '@src/routes/loaders/workspace-scope';
import { ViewType } from '@src/types/ViewType';
import { fakeTabStore, recordRequests, seedBootstrap } from '../utils/dock-loader-harness';

const workspace = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const project = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const other = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

afterEach(() => { vi.restoreAllMocks(); tabManager.resetForTests(); });

it.each([['project and tab', project, true], ['no tab', project, false], ['no project', null, false]] as const)(
  'workspace entry restores %s', async (_label, projectId, hasTab) => {
    seedBootstrap({ workspaces: [{ id: workspace, root_path: '/client', is_default: false }] });
    const tabs = fakeTabStore();
    if (hasTab) tabs.rows.push({
      id: other, project_id: project, pointer: new DockPointer(ViewType.APP, `micro_app-${other}`).toJSON() ?? '',
      target_type: 'micro_app', target_id: other, visible: true, last_active_at: 10, tab_order: 0,
    });
    recordRequests([tabs, req => req.path === `/graph/workspace/${workspace}/last-active-project`
      ? { project_id: projectId } : undefined]);
    const destination = await workspaceEntryDock(DockPointer.root()
      .withOption(WORKSPACE_PARAM, workspace).withOption(WORKSPACE_ENTRY_PARAM, 'resume'));
    expect(destination?.options?.[WORKSPACE_PARAM]).toBe(workspace);
    expect(destination?.options?.[WORKSPACE_ENTRY_PARAM]).toBeUndefined();
    expect(destination?.isRoot).toBe(!hasTab);
    expect(destination?.scopeProjectId ?? null).toBe(projectId);
  },
);
