import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dataManager } from '@sdk';
import { ClaudeSessionFsRecord } from '@sdk/resource_management/fs_records/claude/claude-session';

// Spy on the real dataManager.callAction instead of mocking the entire module
let callActionSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  callActionSpy = vi.spyOn(dataManager, 'callAction').mockResolvedValue(undefined as any);
});

afterEach(() => {
  callActionSpy?.mockRestore();
});

describe('ClaudeSessionFsRecord.fetchTranscript', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callActionSpy.mockResolvedValue(undefined as any);
  });

  it('fetchTranscript_calls_dataManager_with_correct_ActionInfo', async () => {
    const mockEntries = [
      { entry_type: 'user', entry_uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', session_id: 'sid' },
      { entry_type: 'assistant', entry_uuid: 'a1', timestamp: '2026-01-01T00:00:01Z', session_id: 'sid' },
    ];
    callActionSpy.mockResolvedValueOnce(mockEntries as any);

    const result = await ClaudeSessionFsRecord.fetchTranscript('sid');

    expect(callActionSpy).toHaveBeenCalledTimes(1);
    const action = callActionSpy.mock.calls[0][0];
    expect(action.name).toBe('session-transcript');
    expect(action.targetEntity?.type).toBe('compute_node');
    expect(action.targetEntity?.id).toBe('@local');
    expect(action.method).toBe('GET');
    expect(action.queryParameters).toEqual({ session_id: 'sid' });
    expect(result).toEqual(mockEntries);
  });

  it('fetchTranscript_passes_project_option', async () => {
    callActionSpy.mockResolvedValueOnce([] as any);

    await ClaudeSessionFsRecord.fetchTranscript('sid', { project: '/my/project' });

    const action = callActionSpy.mock.calls[0][0];
    expect(action.queryParameters).toEqual({ session_id: 'sid', project: '/my/project' });
  });

  it('fetchTranscript_returns_empty_on_error', async () => {
    callActionSpy.mockRejectedValueOnce(new Error('network failure'));

    const result = await ClaudeSessionFsRecord.fetchTranscript('sid');

    expect(result).toEqual([]);
  });

  it('fetchTranscript_returns_empty_when_null_result', async () => {
    callActionSpy.mockResolvedValueOnce(null as any);

    const result = await ClaudeSessionFsRecord.fetchTranscript('sid');

    expect(result).toEqual([]);
  });
});
