/**
 * ONE panel beside the graph, not two.
 *
 * The inspector and the access editor briefly rendered as separate asides on
 * opposite sides of the canvas, both naming the same node. These assertions pin
 * the shape that replaced them: a single panel, the node's identity in a shared
 * header, and tabs that swap only the body — with the chosen tab surviving a
 * change of selection, because reviewing access means clicking node after node.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@src/hooks/use-access', () => ({
  // Stubbed at the hook so the tab renders its loaded state without a hub.
  useAccess: () => ({
    rules: [{ from_role: 'owner', to_role: 'admin' }],
    ready: true,
    updating: false,
    error: null,
    available: true,
    reason: 'available',
    refresh: () => {},
    save: () => Promise.resolve(),
  }),
}));
vi.mock('@src/components/assets/editor/agent-profile/AgentDeploymentsSection', () => ({
  AgentDeploymentsSection: () => null,
}));
vi.mock('@sdk/react/hooks', () => ({ useEntity: () => ({ data: null }) }));

import { NodePanel } from '@src/components/graph-view/ui/NodePanel';
import type { NodeData } from '@src/components/graph-view/graph/graphModel';

function node(overrides: Partial<NodeData> = {}): NodeData {
  return {
    key: 'team-1',
    type: 'team',
    id: '11111111-1111-4111-8111-111111111111',
    label: 'Platform Class',
    isGhost: false,
    community: 0,
    color: '#888',
    degree: 2,
    properties: {},
    neighbors: [],
    edgeCounts: {},
    parent: {
      key: 'organization-22222222-2222-4222-8222-222222222222',
      type: 'organization',
      id: '22222222-2222-4222-8222-222222222222',
      label: 'Access Demo School',
    },
    ...overrides,
  };
}

const props = {
  localRootKey: null,
  onNeighborClick: () => {},
  onFocus: () => {},
  onClose: () => {},
  onChanged: () => {},
};

// This tier has no global auto-cleanup, so renders would otherwise stack up in
// one document and every getBy* after the first test would find duplicates.
afterEach(cleanup);

describe('the node panel', () => {
  it('is the only panel, and names the node once', () => {
    render(<NodePanel node={node()} showAccess {...props} />);

    expect(screen.getAllByTestId('node-panel')).toHaveLength(1);
    // The label belongs to the header, not to each tab — so exactly one copy.
    expect(screen.getAllByText('Platform Class')).toHaveLength(1);
  });

  it('opens on Details and swaps only the body when Access is picked', async () => {
    render(<NodePanel node={node()} showAccess {...props} />);

    expect(screen.getByText('Identity')).toBeTruthy();
    await userEvent.click(screen.getByTestId('tab-access'));

    expect(screen.queryByText('Identity')).toBeNull();
    expect(screen.getByTestId('access-parent').textContent).toBe('Access Demo School');
    // Header survives the swap.
    expect(screen.getByText('Platform Class')).toBeTruthy();
  });

  it('keeps the chosen tab when the selection changes', async () => {
    const { rerender } = render(<NodePanel node={node()} showAccess {...props} />);
    await userEvent.click(screen.getByTestId('tab-access'));

    rerender(<NodePanel node={node({ key: 'team-2', label: 'Another Class' })} showAccess {...props} />);

    expect(screen.getByTestId('tab-access').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Another Class')).toBeTruthy();
  });

  it('shows no tab strip where access has no meaning', () => {
    render(<NodePanel node={node()} showAccess={false} {...props} />);

    expect(screen.queryByTestId('tab-access')).toBeNull();
    expect(screen.getByText('Identity')).toBeTruthy();
  });

  it('says so plainly when the node has no container', async () => {
    render(<NodePanel node={node({ parent: null })} showAccess {...props} />);
    await userEvent.click(screen.getByTestId('tab-access'));

    expect(screen.getByText(/no container in this view/)).toBeTruthy();
  });
});
