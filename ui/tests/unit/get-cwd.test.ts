import { describe, it, expect, beforeEach, vi } from 'vitest';
import { dataManager, ComputeNode } from '@sdk';

describe('ComputeNode.getCwd', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('calls get-cwd action with correct ActionInfo and returns cwd', async () => {
    const spy = vi.spyOn(dataManager, 'callAction').mockResolvedValue({ cwd: '/home/user/project' } as any);

    const node = new ComputeNode({ id: '@local' });
    const result = await node.getCwd();

    expect(result).toBe('/home/user/project');
    const actionInfo = spy.mock.calls[0][0];
    expect(actionInfo.name).toBe('get-cwd');
    expect(actionInfo.targetEntity?.type).toBe(ComputeNode.type);
    expect(actionInfo.targetEntity?.id).toBe('@local');
  });

  it('returns empty string when cwd key is missing', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue({} as any);
    const result = await new ComputeNode({ id: '@local' }).getCwd();
    expect(result).toBe('');
  });

  it('returns empty string when response is null', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue(null as any);
    const result = await new ComputeNode({ id: '@local' }).getCwd();
    expect(result).toBe('');
  });
});
