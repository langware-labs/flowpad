import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSessionAnalyze } from '@src/hooks/use-session-analyze';

const {
  mockToast,
  mockSpawn,
  mockMkdir,
  mockTaskSave,
  mockProcessResultGetById,
  mockDataContext,
} = vi.hoisted(() => ({
  mockToast: vi.fn(),
  mockSpawn: vi.fn(),
  mockMkdir: vi.fn(),
  mockTaskSave: vi.fn(),
  mockProcessResultGetById: vi.fn(),
  mockDataContext: {
    computeNode: {
      typeId: { toString: () => 'compute_node-@local' },
    } as any,
    bootstrapInfo: { desktop_info: { paths: { home: '/home/ran' } } },
  },
}));

vi.mock('@sdk', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@sdk')>();
  return {
    ...orig,
    dataContext: mockDataContext,
    fsManager: { mkdir: (...args: any[]) => mockMkdir(...args) },
    ProcessResult: { getById: (...args: any[]) => mockProcessResultGetById(...args) },
    AgenticProcess: {
      ...orig.AgenticProcess,
      spawn: (...args: any[]) => mockSpawn(...args),
    },
    Task: class MockTask {
      [key: string]: any;
      constructor(data: any) {
        Object.assign(this, data);
      }
      save = mockTaskSave;
    },
  };
});

vi.mock('@sdk/react/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sdk/react/hooks')>()),
  useProject: () => ({ project: { typeId: 'project-123' } }),
}));

vi.mock('@src/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockDataContext.computeNode = {
    typeId: { toString: () => 'compute_node-@local' },
  };
});

describe('useSessionAnalyze', () => {
  it('returns analyzeSession function and null analyzingSessionId', () => {
    const { result } = renderHook(() => useSessionAnalyze());
    expect(typeof result.current.analyzeSession).toBe('function');
    expect(result.current.analyzingSessionId).toBeNull();
  });

  it('guards against double invocation', async () => {
    const mockProcess = {
      id: 'proc-1',
      worker_session_id: 'ws-1',
      on: vi.fn(),
      executeInstruction: vi.fn(),
    };
    mockSpawn.mockResolvedValue({ process: mockProcess });
    mockMkdir.mockResolvedValue(undefined);
    mockTaskSave.mockResolvedValue(undefined);
    mockProcessResultGetById.mockResolvedValue(null);

    const { result } = renderHook(() => useSessionAnalyze());

    act(() => {
      void result.current.analyzeSession('session-1', '/home/project');
    });

    act(() => {
      void result.current.analyzeSession('session-1', '/home/project');
    });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('shows toast when computeNode is unavailable', async () => {
    mockDataContext.computeNode = null;

    const { result } = renderHook(() => useSessionAnalyze());
    await act(async () => {
      await result.current.analyzeSession('session-1', '/home/project');
    });

    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Compute node unavailable', variant: 'destructive' }),
    );
  });

  it('creates process with fork/resume context', async () => {
    const mockProcess = {
      id: 'proc-abc',
      worker_session_id: 'ws-1',
      on: vi.fn(),
      executeInstruction: vi.fn().mockResolvedValue(undefined),
    };
    mockSpawn.mockResolvedValue({ process: mockProcess });
    mockMkdir.mockResolvedValue(undefined);
    mockTaskSave.mockResolvedValue(undefined);
    mockProcessResultGetById.mockResolvedValue(null);

    const { result } = renderHook(() => useSessionAnalyze());
    await act(async () => {
      await result.current.analyzeSession('session-xyz', '/home/project');
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        workdir: '/home/project',
        resumeSessionId: 'session-xyz',
        forkSession: true,
        permissionMode: 'bypassPermissions',
      }),
      expect.objectContaining({
        result: expect.objectContaining({
          resultType: 'analysis',
          sourceSessionId: 'session-xyz',
        }),
      }),
    );
  });

  it('sets up complete and error event listeners', async () => {
    const mockProcess = {
      id: 'proc-abc',
      worker_session_id: 'ws-1',
      on: vi.fn(),
      executeInstruction: vi.fn().mockResolvedValue(undefined),
    };
    mockSpawn.mockResolvedValue({ process: mockProcess });
    mockMkdir.mockResolvedValue(undefined);
    mockTaskSave.mockResolvedValue(undefined);
    mockProcessResultGetById.mockResolvedValue(null);

    const { result } = renderHook(() => useSessionAnalyze());
    await act(async () => {
      await result.current.analyzeSession('session-xyz', '/home/project');
    });

    const onCalls = mockProcess.on.mock.calls.map((c: any[]) => c[0]);
    expect(onCalls).toContain('complete');
    expect(onCalls).toContain('error');
  });

  it('calls onStarted callback after execution', async () => {
    vi.useFakeTimers();
    const onStarted = vi.fn();
    const mockProcess = {
      id: 'proc-1',
      worker_session_id: 'ws-1',
      on: vi.fn(),
      executeInstruction: vi.fn().mockResolvedValue(undefined),
    };
    mockSpawn.mockResolvedValue({ process: mockProcess });
    mockMkdir.mockResolvedValue(undefined);
    mockTaskSave.mockResolvedValue(undefined);
    mockProcessResultGetById.mockResolvedValue(null);

    const { result } = renderHook(() => useSessionAnalyze({ onStarted }));
    await act(async () => {
      await result.current.analyzeSession('session-1', '/home/project');
    });

    expect(onStarted).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onStarted).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});
