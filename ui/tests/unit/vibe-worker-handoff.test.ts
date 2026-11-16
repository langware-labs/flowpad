import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const prompt = vi.fn().mockResolvedValue(undefined);
  const createdProcess = {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    project_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    prompt,
    loadEmbeddedSubagent: vi.fn().mockResolvedValue(undefined),
    watch: vi.fn().mockResolvedValue(undefined),
    // The launch watch is a lease that listens for the process's end.
    on: vi.fn(() => () => undefined),
  };
  return {
    prompt,
    createdProcess,
    createProcess: vi.fn().mockResolvedValue(createdProcess),
    openShellProcess: vi.fn(),
    continuationPrompt: vi.fn().mockResolvedValue('HANDOFF PROMPT — unchanged'),
  };
});

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return {
    ...actual,
    SubAgent: {
      type: 'agent',
      query: vi.fn().mockResolvedValue([]),
    },
    apiClient: { get: vi.fn().mockResolvedValue([]) },
    ComputeNode: {
      getById: vi.fn().mockResolvedValue({ createProcess: mocks.createProcess }),
    },
    dataContext: { bootstrapInfo: null },
  };
});
vi.mock('@sdk/react/hooks', () => ({ useProject: vi.fn(() => ({ project: null })) }));

import {
  continueVibeSessionForProject,
  createVibeProcessForProject,
} from '@src/pages/flow-page/use-start-vibe-session';

describe('continueVibeSessionForProject', () => {
  beforeEach(() => {
    mocks.prompt.mockClear();
    mocks.createProcess.mockClear();
    mocks.openShellProcess.mockClear();
    mocks.continuationPrompt.mockClear();
  });

  it('forwards the backend prompt and explicit alternative worker unchanged', async () => {
    const sourceProcess = {
      continuationPrompt: mocks.continuationPrompt,
    };

    await continueVibeSessionForProject({
      sourceProcess: sourceProcess as never,
      projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      workdir: '/workspace',
      targetVfsPath: 'markdown-cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      navigation: { openShellProcess: mocks.openShellProcess },
      model: 'md',
      workerType: 'codex',
    });

    expect(mocks.continuationPrompt).toHaveBeenCalledOnce();
    expect(mocks.createProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        workerType: 'codex',
        model: 'md',
        targetVfsPath: 'markdown-cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      }),
      // The caller establishes the watch instead of createProcess awaiting it.
      { pty_mode: false, watchProcess: false },
    );
    expect(mocks.prompt).toHaveBeenCalledWith('HANDOFF PROMPT — unchanged');
  });

  it.each([undefined, null])('omits the model at the SDK create boundary for %s', async (model) => {
    await createVibeProcessForProject({ projectId: null, open: false, model });
    expect(mocks.createProcess.mock.calls[0][0]).not.toHaveProperty('model');
  });

  it('preserves an explicit concrete model at the SDK create boundary', async () => {
    await createVibeProcessForProject({ projectId: null, open: false, model: 'provider/explicit' });
    expect(mocks.createProcess.mock.calls[0][0]).toHaveProperty('model', 'provider/explicit');
  });

  it('does not invent a model when continuing with another worker', async () => {
    await continueVibeSessionForProject({
      sourceProcess: { continuationPrompt: mocks.continuationPrompt } as never,
      projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      navigation: { openShellProcess: mocks.openShellProcess },
      workerType: 'codex',
    });
    expect(mocks.createProcess.mock.calls[0][0]).not.toHaveProperty('model');
  });
});
