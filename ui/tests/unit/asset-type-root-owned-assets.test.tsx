/**
 * An asset nested inside another asset renders under its OWNER, not as a second
 * top-level row of its own type.
 *
 * The bug this pins: `Agent.add_mcp` deliberately materializes a self-contained
 * copy of an Mcp under the agent's own folder, the indexer walks into it, and
 * the copy became an extra `mcp` row next to the project-level one it was copied
 * from — `my-very-first-mcp` three times over for one logical server. The server
 * now drops those from a type listing (`top_level=true`) and hands them back
 * under the owner (`parent_type_id=<owner>`); these tests cover the tree half.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { SearchResult } from '@src/hooks/use-asset-search';

const AGENT_TYPEID = 'agent-bb5cf2b1-c7ff-47cd-8df4-149fe5bba3c6';

// The registry answers "can this type own assets?" from `shape.kind`: a folder
// shape can own nested assets under its own `agentic-assets/`.
const TYPE_INFOS = [
  { type_name: 'agent', shape: { kind: 'folder', main: 'agent.md' } },
  { type_name: 'mcp', shape: { kind: 'folder', main: 'mcp.json' } },
  { type_name: 'markdown', shape: { kind: 'file', ext: '.md' } },
];

const getMock = vi.fn();

vi.mock('@sdk/client', () => ({
  default: { get: (...args: unknown[]) => getMock(...args), delete: vi.fn() },
  apiClient: { get: (...args: unknown[]) => getMock(...args), delete: vi.fn() },
}));

vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  dataManager: { getAllTypeInfos: () => TYPE_INFOS },
}));

const { buildAssetChild } = await import('@src/components/browseable-tree/adapters/assetTypeRoot');

function row(overrides: Partial<SearchResult> & Pick<SearchResult, 'record_id' | 'record_type' | 'name'>): SearchResult {
  return {
    snippet: null,
    status: '',
    scope: 'user',
    asset_ref: `/w/${overrides.name}`,
    created_at: '',
    modified_at: '',
    ...overrides,
  } as SearchResult;
}

const agentRow = row({
  record_id: 'bb5cf2b1-c7ff-47cd-8df4-149fe5bba3c6',
  record_type: 'agent',
  name: 'mcp-tester',
  asset_ref: '/w/proj/agentic-assets/agent/mcp-tester/agent.md',
});

const ownedMcps: SearchResult[] = [
  row({
    record_id: '81209983-f7b3-49be-9ab5-8de6701a33b5',
    record_type: 'mcp',
    name: 'my-very-first-mcp',
    asset_ref: '/w/proj/agentic-assets/agent/mcp-tester/agentic-assets/mcp/my-very-first-mcp',
    parent_type_id: AGENT_TYPEID,
  }),
  row({
    record_id: '41eb2010-1d08-4f76-9d6b-0af351611d81',
    record_type: 'mcp',
    name: 'pong-mcp-server',
    asset_ref: '/w/proj/agentic-assets/agent/mcp-tester/agentic-assets/mcp/pong-mcp-server',
    parent_type_id: AGENT_TYPEID,
  }),
];

beforeEach(() => getMock.mockReset());
afterEach(() => vi.restoreAllMocks());

describe('assets owned by another asset', () => {
  it('gives a folder-shaped row a chevron even when its file tree is not browsable', () => {
    const node = buildAssetChild('agent', agentRow, false, 'asset-type:agent');
    // `false` here is the browsable-folder flag — before this change the row had
    // `hasChildren: false` and no way to show the Mcps it owns.
    expect(node.hasChildren).toBe('unknown');
    expect(node.listChildren).toBeTypeOf('function');
  });

  it('lists the owner s assets, asking the server by parent_type_id', async () => {
    getMock.mockResolvedValue({ results: ownedMcps });
    const node = buildAssetChild('agent', agentRow, false, 'asset-type:agent');

    const children = await node.listChildren!();

    const url = String(getMock.mock.calls[0][0]);
    expect(url).toContain(`parent_type_id=${encodeURIComponent(AGENT_TYPEID)}`);
    // Containment travels on the pointer, never on the path: the request must
    // not smuggle the nested `agentic-assets` path shape in as the filter.
    expect(url).not.toContain('agentic-assets');
    expect(children.map((c) => c.label)).toEqual(['my-very-first-mcp', 'pong-mcp-server']);
  });

  it('keeps a file-layout row a leaf, so 400 markdown rows grow no chevrons', () => {
    const md = row({ record_id: 'c0ffee00-0000-4000-8000-000000000001', record_type: 'markdown', name: 'notes.md' });
    const node = buildAssetChild('markdown', md, false, 'asset-type:markdown');
    expect(node.hasChildren).toBe(false);
    expect(node.listChildren).toBeUndefined();
    expect(getMock).not.toHaveBeenCalled();
  });

  it('drops a row that claims itself as its own parent instead of expanding forever', async () => {
    getMock.mockResolvedValue({
      results: [
        row({
          record_id: 'bb5cf2b1-c7ff-47cd-8df4-149fe5bba3c6',
          record_type: 'agent',
          name: 'mcp-tester',
          parent_type_id: AGENT_TYPEID,
        }),
        ...ownedMcps,
      ],
    });
    const node = buildAssetChild('agent', agentRow, false, 'asset-type:agent');
    const children = await node.listChildren!();
    expect(children.map((c) => c.label)).toEqual(['my-very-first-mcp', 'pong-mcp-server']);
  });

  it('survives a failed children fetch without breaking the row', async () => {
    getMock.mockRejectedValue(new Error('offline'));
    const node = buildAssetChild('agent', agentRow, false, 'asset-type:agent');
    await expect(node.listChildren!()).resolves.toEqual([]);
  });
});
