import { AgenticProcess, Tab } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewMode } from '@src/contexts/view-mode-context';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  create: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('@src/pages/flow-page/use-start-vibe-session', () => ({
  createVibeProcessForProject: h.create,
}));
vi.mock('@src/pages/flow-page/vibe-process-resolver', () => ({
  resolveTargetVibeChat: h.resolve,
}));

import { resolveColdOpenParent } from '@src/tabs/vibe-parent';

const PROJECT_ID = '66c05e11-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROCESS_ID = 'a6c05e11-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROCESS_TAB_ID = 'b6c05e11-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function process(): AgenticProcess {
  return new AgenticProcess({
    id: PROCESS_ID,
    project_id: PROJECT_ID,
    process_type: 'chat',
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  h.create.mockReset();
  h.resolve.mockReset();
});

describe('cold Vibe asset parent resolution', () => {
  it('uses the URL-scoped project without re-resolving an already-open asset', async () => {
    const dock = DockPointer.fromUrl(
      `/dock/assets/editor/markdown/typeid/markdown-${PROCESS_ID}?viewMode=vibe&scope-mode=project&scope-activeProjectId=${PROJECT_ID}`,
    );
    const existing = process();
    h.resolve.mockResolvedValue(existing);
    const resolveDockTarget = vi.spyOn(Tab, 'resolveDockTarget');
    const newTab = vi.spyOn(Tab, 'newTab').mockResolvedValue([
      new Tab({
        id: PROCESS_TAB_ID,
        pointer: new DockPointer(existing.terminalDockPointer).toJSON() ?? '',
        target_type: AgenticProcess.type,
        target_id: PROCESS_ID,
        visible: true,
      }),
    ]);

    await expect(resolveColdOpenParent(dock)).resolves.toBe(PROCESS_TAB_ID);
    expect(resolveDockTarget).not.toHaveBeenCalled();
    expect(h.resolve).toHaveBeenCalledWith(PROJECT_ID, `markdown-${PROCESS_ID}`);
    expect(h.create).not.toHaveBeenCalled();
    expect(newTab).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        targetType: AgenticProcess.type,
        targetId: PROCESS_ID,
        projectId: PROJECT_ID,
      }),
    );
  });

  it('creates one headless Chat keyed to the raw file target when none exists', async () => {
    const dock = DockPointer.forFile('/project/src/main.ts').withViewMode(ViewMode.Vibe);
    const created = process();
    h.resolve.mockResolvedValue(null);
    h.create.mockResolvedValue(created);
    vi.spyOn(Tab, 'resolveDockTarget').mockResolvedValue({
      targetTypeId: null,
      target: null,
      projectId: PROJECT_ID,
    });
    vi.spyOn(Tab, 'newTab').mockResolvedValue([
      new Tab({
        id: PROCESS_TAB_ID,
        pointer: new DockPointer(created.terminalDockPointer).toJSON() ?? '',
        visible: true,
      }),
    ]);

    await expect(resolveColdOpenParent(dock)).resolves.toBe(PROCESS_TAB_ID);
    expect(h.resolve).toHaveBeenCalledWith(
      PROJECT_ID,
      'compute_node-@local/project/src/main.ts',
    );
    expect(h.create).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      workdir: undefined,
      targetVfsPath: 'compute_node-@local/project/src/main.ts',
      open: false,
    });
  });

  it('does not create an orphan when no project can be resolved', async () => {
    const dock = DockPointer.forFile('/tmp/projectless.ts').withViewMode(ViewMode.Vibe);
    vi.spyOn(Tab, 'resolveDockTarget').mockResolvedValue({
      targetTypeId: null,
      target: null,
      projectId: null,
    });

    await expect(resolveColdOpenParent(dock)).resolves.toBeNull();
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });
});
