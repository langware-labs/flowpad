import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const prompt = vi.fn().mockResolvedValue(undefined);
  const createdProcess = {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    project_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    prompt,
    loadEmbeddedSubagent: vi.fn().mockResolvedValue(undefined),
    watch: vi.fn().mockResolvedValue(undefined),
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

import { continueVibeSessionForProject } from '@src/pages/flow-page/use-start-vibe-session';

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
        targetVfsPath: 'markdown-cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      }),
      // The caller establishes the watch instead of createProcess awaiting it.
      { pty_mode: false, watchProcess: false },
    );
    expect(mocks.prompt).toHaveBeenCalledWith('HANDOFF PROMPT — unchanged');
  });
});
