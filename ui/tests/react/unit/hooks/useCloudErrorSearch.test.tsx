/**
 * Tests for the cloud error search additions in useClaudeErrorRecords:
 *   - searchCloudForErrors
 *   - autoFixErrors
 */
import { AgenticProcess, Task, dataManager } from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ErrorCategory,
  ErrorStatus,
  useClaudeErrorRecords,
  type ClaudeErrorRecord,
  type CloudSearchResult,
} from '@src/hooks/useClaudeErrorRecords';
import { useAction } from '@src/hooks/use-action';
import { unitTestSetup } from '../../../utils/test-utils';

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('@sdk/react/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk/react/hooks')>();
  return {
    ...actual,
    useProject: vi.fn(() => ({ project: null })),
  };
});

vi.mock('@src/hooks/useContext', () => ({
  useContext: vi.fn(() => ({
    computeNode: { typeId: { id: '00000000-0000-4000-a000-000000000001', type: 'compute_node' } },
    cloudLoginAvailable: true,
    user: { id: 'u1' },
    visitorTypeId: null,
    someone: null,
    bootstrapError: null,
    isBootstrapping: false,
    cloudApiUrl: 'https://app.flowpad.ai',
  })),
}));

vi.mock('@src/hooks/use-action', () => ({
  useAction: vi.fn(() => ({ data: [], isLoading: false, refetch: vi.fn() })),
}));

const mockUseAction = vi.mocked(useAction);
const mockUseProject = vi.mocked(useProject);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCloudResult(overrides: Partial<CloudSearchResult> = {}): CloudSearchResult {
  return {
    fingerprint: 'fp000001',
    action: 'analyse',
    instruction: null,
    message: null,
    ...overrides,
  };
}

function makeErrorRecord(overrides: Partial<ClaudeErrorRecord> = {}): ClaudeErrorRecord {
  return {
    id: 'record-1',
    type: 'claude_error',
    name: 'fp000001',
    fingerprint: 'fp000001',
    error_category: ErrorCategory.LOG,
    error_msg: 'Something went wrong',
    hook: '',
    event: '',
    hooks: [],
    root_cause: '',
    traceback: [],
    occurrence_count: 1,
    first_seen: '2024-01-01T00:00:00Z',
    last_seen: '2024-01-01T00:00:00Z',
    session_ids: [],
    last_session_id: '',
    last_jsonl_path: '',
    occurrences: [],
    error_status: ErrorStatus.OPEN,
    ignored_until: '',
    linked_task_id: '',
    worker_session_id: '',
    claude_session_id: '',
    triaged_at: '',
    notes: '',
    ...overrides,
  };
}

// ─── searchCloudForErrors ─────────────────────────────────────────────────────

describe('searchCloudForErrors', () => {
  let callActionSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await unitTestSetup();
    callActionSpy = vi.spyOn(dataManager, 'callAction');
  });

  afterEach(() => {
    callActionSpy.mockRestore();
  });

  it('returns empty array when fingerprints list is empty', async () => {
    const { result } = renderHook(() => useClaudeErrorRecords());
    let results: CloudSearchResult[] = [];
    await act(async () => {
      results = await result.current.searchCloudForErrors([]);
    });
    expect(results).toEqual([]);
    expect(callActionSpy).not.toHaveBeenCalled();
  });

  it('calls search-cloud-errors action with the given fingerprints', async () => {
    const fingerprints = ['fp000001', 'fp000002'];
    const cloudResults = fingerprints.map((fp) => makeCloudResult({ fingerprint: fp }));
    callActionSpy.mockResolvedValueOnce({ results: cloudResults } as never);

    const { result } = renderHook(() => useClaudeErrorRecords());
    let results: CloudSearchResult[] = [];
    await act(async () => {
      results = await result.current.searchCloudForErrors(fingerprints);
    });

    expect(callActionSpy).toHaveBeenCalledOnce();
    expect(results).toHaveLength(2);
    expect(results[0].fingerprint).toBe('fp000001');
    expect(results[1].fingerprint).toBe('fp000002');
  });

  it('returns empty array when callAction result has no data', async () => {
    callActionSpy.mockResolvedValueOnce(null as never);
    const { result } = renderHook(() => useClaudeErrorRecords());
    let results: CloudSearchResult[] = [];
    await act(async () => {
      results = await result.current.searchCloudForErrors(['fp000001']).catch(() => []);
    });
    expect(results).toEqual([]);
  });

  it('returns results with correct action types', async () => {
    const cloudResults: CloudSearchResult[] = [
      makeCloudResult({ fingerprint: 'fp1', action: 'fix', instruction: 'Do X' }),
      makeCloudResult({ fingerprint: 'fp2', action: 'ignore', message: 'False positive' }),
      makeCloudResult({ fingerprint: 'fp3', action: 'analyse' }),
    ];
    callActionSpy.mockResolvedValueOnce({ results: cloudResults } as never);

    const { result } = renderHook(() => useClaudeErrorRecords());
    let results: CloudSearchResult[] = [];
    await act(async () => {
      results = await result.current.searchCloudForErrors(['fp1', 'fp2', 'fp3']);
    });

    expect(results.find((r) => r.fingerprint === 'fp1')?.action).toBe('fix');
    expect(results.find((r) => r.fingerprint === 'fp2')?.action).toBe('ignore');
    expect(results.find((r) => r.fingerprint === 'fp3')?.action).toBe('analyse');
  });
});

// ─── autoFixErrors ────────────────────────────────────────────────────────────
//
// autoFixErrors calls createTaskForError internally, which requires:
//   - allErrors containing the matching ClaudeErrorRecord (from useAction)
//   - projectTypeId (from useProject)
//   - Task.prototype.save (mocked to avoid DB)
//   - AgenticProcess.spawn (spied on)
//   - dataManager.callAction for the _mutate PUT (mocked)

const PROJECT_TYPE_ID = { id: '00000000-0000-4000-a000-000000000002', type: 'project' };

describe('autoFixErrors', () => {
  let spawnSpy: ReturnType<typeof vi.spyOn>;
  let taskSaveSpy: ReturnType<typeof vi.spyOn>;
  let callActionSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await unitTestSetup();

    // Provide matching error records in allErrors
    mockUseAction.mockReturnValue({
      data: [
        makeErrorRecord({ fingerprint: 'fp1', error_msg: 'Error A' }),
        makeErrorRecord({ fingerprint: 'fp2', error_msg: 'Error B' }),
        makeErrorRecord({ fingerprint: 'fp-fail', error_msg: 'Error fail' }),
        makeErrorRecord({ fingerprint: 'fp-seq', error_msg: 'Error seq' }),
      ],
      isLoading: false,
      refetch: vi.fn(),
    } as never);

    // Provide a project so projectTypeId is set
    mockUseProject.mockReturnValue({
      project: { typeId: PROJECT_TYPE_ID } as never,
    });

    // Prevent Task.save from hitting the DB
    taskSaveSpy = vi.spyOn(Task.prototype, 'save').mockResolvedValue(undefined as never);

    // Spy on spawn (called inside createTaskForError)
    spawnSpy = vi.spyOn(AgenticProcess, 'spawn').mockResolvedValue({
      process: { worker_session_id: 'ws-1' },
      shell: { id: 'shell-1' },
    } as never);

    // Mock callAction for _mutate PUT calls (inside createTaskForError)
    callActionSpy = vi.spyOn(dataManager, 'callAction').mockResolvedValue({} as never);
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    taskSaveSpy.mockRestore();
    callActionSpy.mockRestore();
  });

  it('spawns an AgenticProcess for each fix result with an instruction', async () => {
    const fixResults: CloudSearchResult[] = [
      makeCloudResult({ fingerprint: 'fp1', action: 'fix', instruction: 'Fix A' }),
      makeCloudResult({ fingerprint: 'fp2', action: 'fix', instruction: 'Fix B' }),
    ];

    const { result } = renderHook(() => useClaudeErrorRecords());
    const progress: Record<string, string> = {};

    await act(async () => {
      await result.current.autoFixErrors(fixResults, (fp, status) => {
        progress[fp] = status;
      });
    });

    expect(spawnSpy).toHaveBeenCalledTimes(2);
    expect(progress['fp1']).toBe('fixed');
    expect(progress['fp2']).toBe('fixed');
  });

  it('passes the cloud instruction to AgenticProcess.spawn', async () => {
    const instruction = 'Apply the patch from PR #42';
    const fixResults: CloudSearchResult[] = [
      makeCloudResult({ fingerprint: 'fp1', action: 'fix', instruction }),
    ];

    const { result } = renderHook(() => useClaudeErrorRecords());

    await act(async () => {
      await result.current.autoFixErrors(fixResults, () => {});
    });

    expect(spawnSpy).toHaveBeenCalledOnce();
    const [, spawnOptions] = spawnSpy.mock.calls[0];
    expect((spawnOptions as { instruction: string }).instruction).toBe(instruction);
  });

  it('skips fix results with no instruction', async () => {
    const fixResults: CloudSearchResult[] = [
      makeCloudResult({ action: 'fix', instruction: null }),
    ];
    const { result } = renderHook(() => useClaudeErrorRecords());
    const progress: Record<string, string> = {};

    await act(async () => {
      await result.current.autoFixErrors(fixResults, (fp, status) => {
        progress[fp] = status;
      });
    });

    expect(spawnSpy).not.toHaveBeenCalled();
    expect(Object.keys(progress)).toHaveLength(0);
  });

  it('skips fix results with no matching error record', async () => {
    const fixResults: CloudSearchResult[] = [
      makeCloudResult({ fingerprint: 'unknown-fp', action: 'fix', instruction: 'Fix it' }),
    ];
    const { result } = renderHook(() => useClaudeErrorRecords());
    const progress: Record<string, string> = {};

    await act(async () => {
      await result.current.autoFixErrors(fixResults, (fp, status) => {
        progress[fp] = status;
      });
    });

    expect(spawnSpy).not.toHaveBeenCalled();
    expect(Object.keys(progress)).toHaveLength(0);
  });

  it('reports error status when spawn fails', async () => {
    spawnSpy.mockRejectedValueOnce(new Error('spawn failed'));

    const fixResults: CloudSearchResult[] = [
      makeCloudResult({ fingerprint: 'fp-fail', action: 'fix', instruction: 'Fix X' }),
    ];

    const { result } = renderHook(() => useClaudeErrorRecords());
    const progress: Record<string, string> = {};

    await act(async () => {
      await result.current.autoFixErrors(fixResults, (fp, status) => {
        progress[fp] = status;
      });
    });

    expect(progress['fp-fail']).toBe('error');
  });

  it('reports fixing before fixed in order', async () => {
    const fixResults: CloudSearchResult[] = [
      makeCloudResult({ fingerprint: 'fp-seq', action: 'fix', instruction: 'Fix' }),
    ];
    const statusHistory: string[] = [];

    const { result } = renderHook(() => useClaudeErrorRecords());

    await act(async () => {
      await result.current.autoFixErrors(fixResults, (_fp, status) => {
        statusHistory.push(status);
      });
    });

    expect(statusHistory).toEqual(['fixing', 'fixed']);
  });
});
