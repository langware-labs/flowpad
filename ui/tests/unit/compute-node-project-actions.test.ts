import {
  dataManager,
  listProjectsFromComputeNode,
  scanProjectFromComputeNode,
} from '@sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('compute-node project actions', () => {
  it('lists projects through an abortable entity action', async () => {
    const controller = new AbortController();
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue({
      projects: [],
      total_count: 0,
    } as never);

    await listProjectsFromComputeNode('@local', controller.signal);

    const action = call.mock.calls[0][0];
    expect(action.name).toBe('list-projects');
    expect(action.targetEntity?.type).toBe('compute_node');
    expect(action.targetEntity?.id).toBe('@local');
    expect(action.abortSignal).toBe(controller.signal);
  });

  it('scans a project through an action with typed query parameters', async () => {
    const controller = new AbortController();
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue(null as never);

    await scanProjectFromComputeNode('@local', '-work-flowpad', 25, false, controller.signal);

    const action = call.mock.calls[0][0];
    expect(action.name).toBe('scan-project');
    expect(action.queryParameters).toEqual({
      project: '-work-flowpad',
      limit: 25,
      include_sessions: false,
    });
    expect(action.abortSignal).toBe(controller.signal);
  });
});
