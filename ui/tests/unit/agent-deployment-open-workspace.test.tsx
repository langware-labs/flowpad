/**
 * The deployment page's "open workspace" arrow: beside the title, a link that opens the machine's
 * workspace in a new tab through the hub's `/compute_node/<id>` page — offered only when the
 * deployment sits on a machine and the hub's address is known.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const NODE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const AGENT_ID = '11111111-2222-4333-8444-555555555555';
const DEPLOYMENT_ID = '99999999-8888-4777-8666-555555555555';
const HUB = 'https://staging.flowpad.ai';

// The page's data comes from hooks that need a store and a router; the arrow reads only the deployment.
const state = vi.hoisted(() => ({ deployment: null as unknown }));
vi.mock('@sdk/react/hooks', async (original) => ({
  ...(await original<object>()),
  useEntity: () => ({ data: state.deployment }),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() }, currentDock: null }),
}));
vi.mock('@src/components/assets/editor/agent-profile/use-agent-places', () => ({
  useAgentPlaces: () => ({ places: [], reload: vi.fn() }),
}));
vi.mock('@src/components/assets/editor/agent-profile/deployment/use-deployment-threads', () => ({
  useDeploymentThreads: () => ({ threads: [], error: null }),
}));
vi.mock('@src/components/assets/editor/agent-profile/deployment/DeploymentHealth', () => ({
  DeploymentHealth: () => null,
}));
vi.mock('@src/components/assets/editor/agent-profile/deployment/DeploymentProcessPanel', () => ({
  DeploymentProcessPanel: () => null,
}));
vi.mock('@src/components/assets/editor/agent-profile/deployment/DeploymentThreads', () => ({
  DeploymentThreads: () => null,
}));
vi.mock('@src/components/assets/editor/agent-profile/AgentPlaceCard', () => ({ AgentPlaceCard: () => null }));

const { Agent, cloudManager, Deployment } = await import('@sdk');
const { AgentDeploymentPage } = await import(
  '@src/components/assets/editor/agent-profile/deployment/AgentDeploymentPage'
);

const deployment = (provider: string, externalId: string) =>
  new Deployment({
    id: DEPLOYMENT_ID,
    name: 'Hello World Agent (e2b)',
    target: { provider, scope: 'sandbox' },
    origin: { kind: 'compute.node', provider, external_id: externalId },
  } as never);

const show = (row: unknown, hubUrl = HUB) => {
  state.deployment = row;
  vi.spyOn(cloudManager, 'cloudAppUrl', 'get').mockReturnValue(hubUrl);
  render(<AgentDeploymentPage agent={new Agent({ id: AGENT_ID, name: 'q' })} deploymentId={DEPLOYMENT_ID} />);
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AgentDeploymentPage — open workspace', () => {
  it("links to the hub's page for the deployment's machine, in a new tab", () => {
    show(deployment('e2b', `compute_node-${NODE_ID}`));

    const link = screen.getByTestId('deployment-open-workspace');
    expect(link).toHaveAttribute('href', `${HUB}/compute_node/${NODE_ID}`);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAccessibleName("Open this deployment's workspace in a new tab");
  });

  it('sits in the header beside the deployment title', () => {
    show(deployment('e2b', `compute_node-${NODE_ID}`));

    const header = screen.getByRole('heading', { level: 1 }).parentElement;
    expect(header).toContainElement(screen.getByTestId('deployment-open-workspace'));
  });

  it('does not double the slash when the hub url ends with one', () => {
    show(deployment('e2b', `compute_node-${NODE_ID}`), `${HUB}/`);

    expect(screen.getByTestId('deployment-open-workspace')).toHaveAttribute('href', `${HUB}/compute_node/${NODE_ID}`);
  });

  it('is absent until the hub url is known', () => {
    show(deployment('e2b', `compute_node-${NODE_ID}`), '');

    expect(screen.queryByTestId('deployment-open-workspace')).not.toBeInTheDocument();
  });

  it('is absent before a machine is allocated — the placement has no node yet', () => {
    show(deployment('e2b', ''));

    expect(screen.queryByTestId('deployment-open-workspace')).not.toBeInTheDocument();
  });

  it("is absent for an inventoried resource — its external id is the provider's own name, not a machine", () => {
    show(deployment('gcp', `compute_node-${NODE_ID}`));

    expect(screen.queryByTestId('deployment-open-workspace')).not.toBeInTheDocument();
  });

  it('is absent for a local deployment — this computer has no hub workspace to open', () => {
    show(deployment('local', `compute_node-${NODE_ID}`));

    expect(screen.queryByTestId('deployment-open-workspace')).not.toBeInTheDocument();
  });

  it('is absent, and the page still renders, when the machine id is not a compute_node typeid', () => {
    show(deployment('e2b', 'sbx_not-a-typeid'));

    expect(screen.getByTestId('agent-deployment-page')).toBeInTheDocument();
    expect(screen.queryByTestId('deployment-open-workspace')).not.toBeInTheDocument();
  });

  it('is absent while the deployment has not loaded', () => {
    show(null);

    expect(screen.queryByTestId('deployment-open-workspace')).not.toBeInTheDocument();
  });
});
