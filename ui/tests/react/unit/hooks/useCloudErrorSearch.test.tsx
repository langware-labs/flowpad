/**
 * Tests for the cloud error search additions in useClaudeErrorRecords:
 *   - searchCloudForErrors
 *   - fixAllCloud
 */
import { dataManager } from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ErrorCategory,
  ErrorStatus,
  useClaudeErrorRecords,
  type ClaudeErrorRecord,
  type CloudSearchResult,
  type Fix,
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
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
    fix: { instruction: '', message: '' } satisfies Fix,
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

// ─── fixAllCloud ──────────────────────────────────────────────────────────────

describe('fixAllCloud', () => {
  let callActionSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await unitTestSetup();

    mockUseAction.mockReturnValue({
      data: [
        makeErrorRecord({ fingerprint: 'fp1', fix: { instruction: 'Fix A', message: '' } }),
        makeErrorRecord({ fingerprint: 'fp2', fix: { instruction: 'Fix B', message: '' } }),
      ],
      isLoading: false,
      refetch: vi.fn(),
    } as never);

    callActionSpy = vi.spyOn(dataManager, 'callAction');
  });

  afterEach(() => {
    callActionSpy.mockRestore();
    mockUseAction.mockReset();
  });

  it('returns empty array when fingerprints list is empty', async () => {
    const { result } = renderHook(() => useClaudeErrorRecords());
    let out: unknown[] = [];
    await act(async () => {
      out = await result.current.fixAllCloud([]);
    });
    expect(out).toEqual([]);
    expect(callActionSpy).not.toHaveBeenCalled();
  });

  it('calls fix-all-cloud-errors action with the given fingerprints', async () => {
    const spawned = [
      { fingerprint: 'fp1', status: 'spawned', shell_id: 'sh-1', worker_session_id: 'ws-1' },
      { fingerprint: 'fp2', status: 'spawned', shell_id: 'sh-2', worker_session_id: 'ws-2' },
    ];
    callActionSpy.mockResolvedValueOnce({ spawned } as never);

    const { result } = renderHook(() => useClaudeErrorRecords());
    let out: unknown[] = [];
    await act(async () => {
      out = await result.current.fixAllCloud(['fp1', 'fp2']);
    });

    expect(callActionSpy).toHaveBeenCalledOnce();
    const callArg = callActionSpy.mock.calls[0][0] as { bodyParameters?: { fingerprints: string[] } };
    expect(callArg.bodyParameters?.fingerprints).toEqual(['fp1', 'fp2']);
    expect(out).toHaveLength(2);
    expect((out[0] as { status: string }).status).toBe('spawned');
  });

  it('returns empty array when server returns null', async () => {
    callActionSpy.mockResolvedValueOnce(null as never);
    const { result } = renderHook(() => useClaudeErrorRecords());
    let out: unknown[] = [1, 2]; // non-empty sentinel
    await act(async () => {
      out = await result.current.fixAllCloud(['fp1']);
    });
    expect(out).toEqual([]);
  });
});
