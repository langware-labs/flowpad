/**
 * Loader project-scope contract for GLOBAL (projectless) targets.
 *
 * The strip now scopes each tab to EXACTLY one project (or the Global scope), so
 * "open a global tab ⇒ enter the Global scope" must hold: navigating to a target
 * with no owning project has to CLEAR the active project to null. That clear is
 * owned by `systemTools.resolveProjectContext` (one policy, one place); a loader's
 * job is just to route a projectless target THROUGH it.
 *
 * `load-lens` is the representative loader (shell/process/session share the same
 * branch). This asserts the delegation: a session with a project_id loads that
 * project; a projectless session is handed to `resolveProjectContext`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  getById: vi.fn(),
  resolveProjectContext: vi.fn(async () => undefined),
}));
const loadProjectMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sdk')>()),
  ClaudeSession: { getById: sdk.getById },
  Project: { type: 'project' },
  systemTools: { resolveProjectContext: sdk.resolveProjectContext },
  TypeId: class {
    type: string;
    id: string;
    constructor(type: string, id: string) {
      this.type = type;
      this.id = id;
    }
  },
}));

vi.mock('@src/navigation', () => ({
  DockPointer: {
    // The loader only cares about a claude transcript lens; return one whose ref
    // is the bare session id we pass in.
    parseLensPointer: (p: string) => ({ category: 'claude', type: 'transcript', ref: p }),
  },
}));

vi.mock('@src/routes/loaders/load-project', () => ({ loadProject: loadProjectMock }));

import { loadLensRoute } from '@src/routes/loaders/load-lens';

describe('loadLensRoute — routes a projectless session through resolveProjectContext', () => {
  beforeEach(() => {
    sdk.getById.mockReset();
    sdk.resolveProjectContext.mockReset().mockResolvedValue(undefined);
    loadProjectMock.mockClear();
  });

  it('loads the owning project (not resolveProjectContext) when the session has a project_id', async () => {
    sdk.getById.mockResolvedValue({ project_id: 'p1', cwd: '/x' });

    await loadLensRoute('sess1');

    expect(loadProjectMock).toHaveBeenCalledTimes(1);
    expect(sdk.resolveProjectContext).not.toHaveBeenCalled();
  });

  it('hands a projectless session to resolveProjectContext (which owns the Global-scope clear)', async () => {
    sdk.getById.mockResolvedValue({ project_id: null, cwd: '/some/cwd' });

    await loadLensRoute('sess1');

    expect(loadProjectMock).not.toHaveBeenCalled();
    expect(sdk.resolveProjectContext).toHaveBeenCalledWith('/some/cwd', { parent_type_id: undefined });
  });

  it('threads parent_type_id so a received session scopes to its conversation project', async () => {
    // A RECEIVED transcript: no project_id, no cwd — only the parent pointer to
    // the conversation it was shared into. The loader must hand that pointer to
    // resolveProjectContext (whose parent-chain fallback resolves the project)
    // in a SAVE-LESS shape — dropping the pointer is the bug that dumped these
    // transcripts into Global; passing the session would let the loader persist
    // a recovered unindexed row.
    sdk.getById.mockResolvedValue({
      project_id: null,
      cwd: null,
      parent_type_id: 'conversation-c1',
    });

    await loadLensRoute('sess1');

    expect(loadProjectMock).not.toHaveBeenCalled();
    expect(sdk.resolveProjectContext).toHaveBeenCalledWith(undefined, { parent_type_id: 'conversation-c1' });
  });
});
