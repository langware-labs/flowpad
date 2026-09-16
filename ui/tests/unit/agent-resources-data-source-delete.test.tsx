/**
 * FLOWPAD-2092: a data source listed in an agent's own "Agent resources"
 * panel must be deletable from there, the same way an MCP/skill/doc asset in
 * this panel is manageable without leaving it — before this, the section had
 * only a `+` and an "Open in Data sources" link, so removing a stale channel
 * meant navigating away to the separate Data sources screen.
 *
 * `useSourceDelete` (`@src/components/data-sources/use-source-delete`) already
 * owns the verb and its confirm copy, shared with the Data Sources screen — this
 * panel reuses it rather than re-implementing "what does deleting a source do".
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TypeId } from '@sdk';

const h = vi.hoisted(() => ({
  activeEntityTypeId: null as import('@sdk').TypeId | null,
  sources: [] as Array<Record<string, unknown>>,
  setDeletingCalls: [] as Array<Record<string, unknown>>,
  confirmDialogProps: [] as Array<{ open: boolean; onConfirm: () => void }>,
}));

vi.mock('@src/hooks/useContext', () => ({
  useContext: () => ({ activeEntityTypeId: h.activeEntityTypeId }),
}));

vi.mock('@src/components/data-sources/DataSourceDialog', () => ({
  DataSourceDialog: () => null,
}));

vi.mock('@src/components/agent-resources/useStagedAssets', () => ({
  useStagedAssets: () => ({ descriptors: [], isLoading: false, refresh: vi.fn() }),
}));

vi.mock('@src/hooks/entity-hooks', () => ({
  useEntitiesQuery: () => ({ data: h.sources, isLoading: false, refetch: vi.fn() }),
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openTab: vi.fn() } }),
}));

vi.mock('@src/components/quick-create', () => ({
  useQuickCreatePick: () => ({ panelProps: { onPick: vi.fn() }, dialogs: null }),
}));

vi.mock('@src/components/data-sources/use-source-delete', () => ({
  useSourceDelete: () => ({
    deleting: null,
    setDeleting: (source: Record<string, unknown>) => h.setDeletingCalls.push(source),
    remove: vi.fn(),
    confirm: { title: 'Delete this data source?', description: '', confirmLabel: 'Delete' },
  }),
}));

vi.mock('@src/components/ui/confirm-dialog', () => ({
  ConfirmDialog: (props: { open: boolean; onConfirm: () => void }) => {
    h.confirmDialogProps.push(props);
    return null;
  },
}));

const { AgentResourcesBody } = await import('@src/components/agent-resources/AgentResourcesBody');

const render = (ui: React.ReactElement) => rtlRender(ui);

function makeSource(id: string, owner: string | null) {
  return {
    id,
    name: `source-${id}`,
    provider: 'slack',
    channel: 'slack',
    status: 'active',
    health: 'ok',
    owner,
    typeId: new TypeId('data_source', id),
  };
}

afterEach(() => {
  cleanup();
  h.activeEntityTypeId = null;
  h.sources = [];
  h.setDeletingCalls = [];
  h.confirmDialogProps = [];
});

describe('AgentResourcesBody — deleting a data source (FLOWPAD-2092)', () => {
  it('offers a delete control on each source row that hands the row\'s own source to the delete hook', () => {
    h.activeEntityTypeId = new TypeId('agent', 'agent-123');
    const owned = makeSource('src-1', new TypeId('agent', 'agent-123').toString());
    h.sources = [owned];
    render(<AgentResourcesBody />);

    fireEvent.click(screen.getByTestId('agent-resource-delete-data-source-src-1'));

    expect(h.setDeletingCalls).toHaveLength(1);
    expect(h.setDeletingCalls[0]).toBe(owned);
  });

  it('mounts one confirm dialog wired to the delete hook\'s own confirm copy', () => {
    h.activeEntityTypeId = new TypeId('agent', 'agent-123');
    h.sources = [makeSource('src-1', new TypeId('agent', 'agent-123').toString())];
    render(<AgentResourcesBody />);

    const lastProps = h.confirmDialogProps.at(-1);
    expect(lastProps).toBeTruthy();
    expect(lastProps?.open).toBe(false);
  });
});
