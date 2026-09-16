import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
const inventory = vi.hoisted(() => ({ descriptors: [] as import('@sdk').AssetDescriptor[] }));
vi.mock('@src/components/asset-manager', () => ({ useProcessAssets: () => ({ ...inventory, isLoading: false, refresh: async () => {} }) }));
import { useStagedAssets } from '@src/components/agent-resources/useStagedAssets';

describe('staged attachment policy', () => {
  it('renders server-approved occurrences regardless of path spelling or nesting', () => {
    inventory.descriptors = [
      { typeid: 'mcp-a', source: 'project_dir', posix_path: '/agentic-assets/repo/agentic-assets/mcp/a', attachable: true },
      { typeid: 'mcp-b', source: 'project_dir', posix_path: '/repo/.claude/skills/owner/agentic-assets/mcp/b', attachable: false },
    ];
    const { result } = renderHook(() => useStagedAssets('mcp'));
    expect(result.current.descriptors).toEqual([inventory.descriptors[0]]);
  });
});
