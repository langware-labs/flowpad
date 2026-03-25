import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the APIEntity module before any imports that use it
vi.mock('@sdk/APIEntity', async () => {
  const { ActionInfo } = await import('@sdk/models/ActionInfo');
  return {
    dataManager: {
      callAction: vi.fn(),
    },
    APIEntity: class MockAPIEntity {},
    registerEntity: () => (target: any) => target,
    ActionInfo,
  };
});

// Import after mock is set up (vi.mock is hoisted)
import { dataManager } from '@sdk/APIEntity';
import { ClaudeSessionFsRecord } from '@sdk/resource_management/fs_records/claude/claude-session';

const mockCallAction = vi.mocked(dataManager.callAction);

describe('ClaudeSessionFsRecord.fetchTranscript', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetchTranscript_calls_dataManager_with_correct_ActionInfo', async () => {
    const mockEntries = [
      { entry_type: 'user', entry_uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', session_id: 'sid' },
      { entry_type: 'assistant', entry_uuid: 'a1', timestamp: '2026-01-01T00:00:01Z', session_id: 'sid' },
    ];
    mockCallAction.mockResolvedValueOnce(mockEntries);

    const result = await ClaudeSessionFsRecord.fetchTranscript('sid');

    expect(mockCallAction).toHaveBeenCalledTimes(1);
    const action = mockCallAction.mock.calls[0][0];
    expect(action.name).toBe('session-transcript');
    expect(action.targetEntity?.type).toBe('compute_node');
    expect(action.targetEntity?.id).toBe('@local');
    expect(action.method).toBe('GET');
    expect(action.queryParameters).toEqual({ session_id: 'sid' });
    expect(result).toEqual(mockEntries);
  });

  it('fetchTranscript_passes_project_option', async () => {
    mockCallAction.mockResolvedValueOnce([]);

    await ClaudeSessionFsRecord.fetchTranscript('sid', { project: '/my/project' });

    const action = mockCallAction.mock.calls[0][0];
    expect(action.queryParameters).toEqual({ session_id: 'sid', project: '/my/project' });
  });

  it('fetchTranscript_returns_empty_on_error', async () => {
    mockCallAction.mockRejectedValueOnce(new Error('network failure'));

    const result = await ClaudeSessionFsRecord.fetchTranscript('sid');

    expect(result).toEqual([]);
  });

  it('fetchTranscript_returns_empty_when_null_result', async () => {
    mockCallAction.mockResolvedValueOnce(null);

    const result = await ClaudeSessionFsRecord.fetchTranscript('sid');

    expect(result).toEqual([]);
  });
});
