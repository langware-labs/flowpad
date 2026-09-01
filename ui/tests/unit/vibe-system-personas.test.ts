/**
 * SDK-shipped personas ride every vibe session: one memoized include_system
 * listing serves both the standard `vibe` persona and the `kind: vibe` ones.
 */
import apiClient from '@sdk/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { systemSubagentRef, systemVibeKindSubagentRefs } from '@src/pages/flow-page/vibe-personas';

vi.mock('@sdk/client', () => ({ default: { get: vi.fn() } }));

describe('vibe personas', () => {
  beforeEach(() => vi.mocked(apiClient.get).mockReset());

  it('selects system kind:vibe personas in created-date order, and the standard vibe persona, from ONE listing', async () => {
    vi.mocked(apiClient.get).mockResolvedValue([
      { name: 'later', kind: 'vibe', scope: 'system', asset_ref: '/b.md', created_date: '2026-02-01' },
      { name: 'data-integrations', kind: 'vibe', scope: 'system', asset_ref: '/a.md', created_date: '2026-01-01' },
      { name: 'vibe', kind: 'harness', scope: 'system', asset_ref: '/vibe.md' },
      { name: 'mine', kind: 'vibe', scope: 'project', asset_ref: '/p.md' },
      { name: 'unindexed', kind: 'vibe', scope: 'system' },
    ]);
    expect(await systemVibeKindSubagentRefs()).toEqual(['/a.md', '/b.md']);
    expect(await systemSubagentRef('vibe')).toBe('/vibe.md');
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(apiClient.get).toHaveBeenCalledWith('/graph/subagent?include_system=true');
  });
});
