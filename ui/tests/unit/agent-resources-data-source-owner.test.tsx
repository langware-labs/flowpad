/**
 * FLOWPAD-2092: a data source created from an agent's own "Agent resources"
 * panel must be OWNED by that agent, the same way `AttachedChannelsBar`
 * stamps `owner` when a channel is added from the agent's Inbox view.
 *
 * Before the fix, `AgentResourcesBody` opened `DataSourceDialog` with no
 * `owner` prop at all — a source created from an agent's editor page came
 * back `owner: null`, indistinguishable from an unowned/global source, even
 * though the panel's own doc comment claims to show "what an agent here can
 * actually read from".
 *
 * `useContext()`'s `activeEntityTypeId` is the URL-first signal the asset
 * loader (`load-asset.ts`) already writes for whichever asset is open in the
 * editor — the same seam `FavoritesAddRow` reads to answer "what's open".
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TypeId } from '@sdk';

const h = vi.hoisted(() => ({
  activeEntityTypeId: null as import('@sdk').TypeId | null,
  dataSourceDialogProps: [] as Array<{ owner?: import('@sdk').TypeId | null }>,
  sources: [] as Array<Record<string, unknown>>,
}));

vi.mock('@src/hooks/useContext', () => ({
  useContext: () => ({ activeEntityTypeId: h.activeEntityTypeId }),
}));

vi.mock('@src/components/data-sources/DataSourceDialog', () => ({
  DataSourceDialog: (props: { owner?: TypeId | null }) => {
    h.dataSourceDialogProps.push(props);
    return null;
  },
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
  h.dataSourceDialogProps = [];
  h.sources = [];
});

describe('AgentResourcesBody — data source owner wiring (FLOWPAD-2092)', () => {
  it('stamps the open agent as owner when adding a data source from its editor', () => {
    h.activeEntityTypeId = new TypeId('agent', 'agent-123');
    render(<AgentResourcesBody />);

    fireEvent.click(screen.getByTestId('agent-resource-add-data-source'));

    const lastProps = h.dataSourceDialogProps.at(-1);
    expect(lastProps?.owner).toBeInstanceOf(TypeId);
    expect(lastProps?.owner?.toString()).toBe(new TypeId('agent', 'agent-123').toString());
  });

  it('passes no owner when the open asset is not an agent', () => {
    h.activeEntityTypeId = new TypeId('markdown', 'doc-1');
    render(<AgentResourcesBody />);

    fireEvent.click(screen.getByTestId('agent-resource-add-data-source'));

    const lastProps = h.dataSourceDialogProps.at(-1);
    expect(lastProps?.owner ?? null).toBeNull();
  });

  it('passes no owner when nothing is open', () => {
    h.activeEntityTypeId = null;
    render(<AgentResourcesBody />);

    fireEvent.click(screen.getByTestId('agent-resource-add-data-source'));

    const lastProps = h.dataSourceDialogProps.at(-1);
    expect(lastProps?.owner ?? null).toBeNull();
  });
});

describe('AgentResourcesBody — data source list scoped to the open agent (FLOWPAD-2092)', () => {
  it('shows only sources owned by the agent currently being edited', () => {
    h.activeEntityTypeId = new TypeId('agent', 'agent-123');
    h.sources = [
      makeSource('src-1', new TypeId('agent', 'agent-123').toString()),
      makeSource('src-2', new TypeId('agent', 'agent-999').toString()),
      makeSource('src-3', new TypeId('user', 'user-1').toString()),
      makeSource('src-4', null),
    ];
    render(<AgentResourcesBody />);

    expect(screen.getByText('source-src-1')).toBeInTheDocument();
    expect(screen.queryByText('source-src-2')).not.toBeInTheDocument();
    expect(screen.queryByText('source-src-3')).not.toBeInTheDocument();
    expect(screen.queryByText('source-src-4')).not.toBeInTheDocument();
  });

  it('shows none of the instance\'s sources when no agent is open', () => {
    h.activeEntityTypeId = null;
    h.sources = [makeSource('src-1', new TypeId('agent', 'agent-123').toString())];
    render(<AgentResourcesBody />);

    // The section starts collapsed when settled empty — expand it to see the
    // empty state (`NavigatorSection` only opens children/emptyState while open).
    fireEvent.click(screen.getByTestId('navigator-section-data-sources'));

    expect(screen.queryByText('source-src-1')).not.toBeInTheDocument();
    expect(screen.getByText('Connect a data source to make it available here')).toBeInTheDocument();
  });
});
