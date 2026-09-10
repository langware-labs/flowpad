/**
 * FLOWPAD-2092: an MCP server listed in an agent's own "Agent resources"
 * panel must be deletable from there too, the same way a data source row
 * now is — reusing the SAME generic delete route every other file-backed
 * asset (agent, skill, workflow, plan, markdown, …) already goes through
 * (`showDeleteAssetModal` + `DELETE /graph/<type>/<id>`, see
 * `browseable-tree/adapters/assetTypeRoot.tsx`), not a bespoke MCP verb.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TypeId } from '@sdk';

const h = vi.hoisted(() => ({
  mcpDescriptors: [] as Array<{ typeid: string; source: string; posix_path: string | null; name?: string }>,
  deleteModalRequests: [] as Array<{ name: string; onConfirm: () => Promise<void> }>,
  apiDeleteCalls: [] as string[],
}));

vi.mock('@src/hooks/useContext', () => ({
  useContext: () => ({ activeEntityTypeId: null }),
}));

vi.mock('@src/components/data-sources/DataSourceDialog', () => ({
  DataSourceDialog: () => null,
}));

vi.mock('@src/components/agent-resources/useStagedAssets', () => ({
  useStagedAssets: (type: string) =>
    type === 'mcp'
      ? { descriptors: h.mcpDescriptors, isLoading: false, refresh: vi.fn() }
      : { descriptors: [], isLoading: false, refresh: vi.fn() },
}));

vi.mock('@src/hooks/entity-hooks', () => ({
  useEntitiesQuery: () => ({ data: [], isLoading: false, refetch: vi.fn() }),
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openTab: vi.fn() } }),
}));

vi.mock('@src/components/quick-create', () => ({
  useQuickCreatePick: () => ({ panelProps: { onPick: vi.fn() }, dialogs: null }),
}));

vi.mock('@src/components/data-sources/use-source-delete', () => ({
  useSourceDelete: () => ({ deleting: null, setDeleting: vi.fn(), remove: vi.fn(), confirm: { title: '', description: '', confirmLabel: '' } }),
}));

vi.mock('@src/components/assets/delete-asset-modal', () => ({
  showDeleteAssetModal: (request: { name: string; onConfirm: () => Promise<void> }) => {
    h.deleteModalRequests.push(request);
  },
}));

vi.mock('@sdk/client', () => ({
  default: { delete: (path: string) => { h.apiDeleteCalls.push(path); return Promise.resolve(); } },
}));

const { AgentResourcesBody } = await import('@src/components/agent-resources/AgentResourcesBody');

const render = (ui: React.ReactElement) => rtlRender(ui);

afterEach(() => {
  cleanup();
  h.mcpDescriptors = [];
  h.deleteModalRequests = [];
  h.apiDeleteCalls = [];
});

describe('AgentResourcesBody — deleting an MCP server (FLOWPAD-2092)', () => {
  it('offers a delete control on each MCP row that opens the shared confirm modal', () => {
    const id = new TypeId('mcp', '11111111-1111-4111-8111-111111111111').id;
    h.mcpDescriptors = [{ typeid: `mcp-${id}`, source: 'project', posix_path: null, name: 'my-mcp-server' }];
    render(<AgentResourcesBody />);

    fireEvent.click(screen.getByTestId(`agent-resource-delete-mcp-${id}`));

    expect(h.deleteModalRequests).toHaveLength(1);
    expect(h.deleteModalRequests[0].name).toBe('my-mcp-server');
  });

  it('confirming the modal deletes through the generic graph route for the row\'s type and id', async () => {
    const id = new TypeId('mcp', '22222222-2222-4222-8222-222222222222').id;
    h.mcpDescriptors = [{ typeid: `mcp-${id}`, source: 'project', posix_path: null, name: 'other-server' }];
    render(<AgentResourcesBody />);

    fireEvent.click(screen.getByTestId(`agent-resource-delete-mcp-${id}`));
    await h.deleteModalRequests[0].onConfirm();

    expect(h.apiDeleteCalls).toEqual([`/graph/mcp/${id}`]);
  });
});
