import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgenticProcess, Tab, tabManager, TypeId } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import type { VibeWorkspaceSession } from '@src/pages/flow-page/use-vibe-workspace-session';

const mocks = vi.hoisted(() => ({
  setupTabAndAdopt: vi.fn(),
  requestedTypeId: null as TypeId | null,
  process: {
    id: '5e11aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    target_typeid_str: 'markdown-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  } as AgenticProcess,
}));

vi.mock('@src/hooks/entity-hooks', () => ({
  useEntity: (typeId: TypeId | null) => {
    mocks.requestedTypeId = typeId;
    return { data: mocks.process };
  },
}));
vi.mock('@src/tabs/tab-content-lifecycle', async (orig) => ({
  ...(await orig<typeof import('@src/tabs/tab-content-lifecycle')>()),
  setupTabAndAdopt: mocks.setupTabAndAdopt,
}));

import { useVibeWorkspaceSessionHost } from '@src/pages/flow-page/use-vibe-workspace-session';

afterEach(() => {
  cleanup();
  mocks.requestedTypeId = null;
  mocks.setupTabAndAdopt.mockReset();
});

describe('useVibeWorkspaceSessionHost', () => {
  it('loads and watches the parent process id on a child URL', () => {
    const processDock = new DockPointer(
      ViewType.SHELL,
      `agentic_process-${mocks.process.id}`,
    );
    const processTab = new Tab({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      pointer: JSON.stringify(processDock),
      target_type: AgenticProcess.type,
      target_id: mocks.process.id,
    });
    const session: VibeWorkspaceSession = {
      processId: mocks.process.id,
      processDock,
      processTab,
      onProcessUrl: false,
    };

    const { result, unmount } = renderHook(() =>
      useVibeWorkspaceSessionHost(session),
    );

    expect(mocks.requestedTypeId?.toString()).toBe(
      new TypeId(AgenticProcess.type, mocks.process.id).toString(),
    );
    expect(result.current).toBe(mocks.process);
    // The host no longer registers itself in an ambient slot for the next tab
    // mint to pick up — the URL names it, so the hook only resolves the process.
    // Its one remaining side effect is minting the anchor tab when it is absent,
    // and this session already has one.
    expect(mocks.setupTabAndAdopt).not.toHaveBeenCalled();
    unmount();
  });
});
