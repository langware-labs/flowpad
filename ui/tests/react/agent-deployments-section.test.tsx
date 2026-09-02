import '@testing-library/jest-dom/vitest';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Agent, Deployment } from '@sdk';
import { DeleteAssetModal } from '@src/components/assets/delete-asset-modal';
import { AgentDeploymentsSection } from '@src/components/assets/editor/agent-profile/AgentDeploymentsSection';

const mocks = vi.hoisted(() => ({
  deployments: [] as Deployment[],
  refetch: vi.fn(),
  success: vi.fn(),
}));

vi.mock('@src/navigation/hub-runtime', () => ({ isHubOnly: () => true }));

vi.mock('@src/components/assets/editor/agent-profile/DeployedAgentChatPanel', () => ({
  DeployedAgentChatPanel: ({ deployment }: { deployment: Deployment }) => (
    <div data-testid="deployed-agent-chat">Chat on {deployment.name}</div>
  ),
}));

// The pre-deploy checklist is a whole dependency tree of its own (auth, project,
// git preflight, OAuth) and is pinned in `tests/unit/agent-deploy-checklist.test.tsx`.
// This file is about the deployment rows, so stub it rather than re-mock its world.
vi.mock('@src/components/assets/editor/agent-profile/AgentDeployChecklist', () => ({
  AgentDeployChecklist: () => null,
}));

vi.mock('@sdk/react/hooks', () => ({
  useEntitiesQuery: () => ({ data: mocks.deployments, refetch: mocks.refetch }),
}));

vi.mock('@src/notifications', () => ({
  notify: { error: vi.fn(), info: vi.fn(), success: mocks.success, warning: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.refetch.mockResolvedValue(undefined);
});

describe('AgentDeploymentsSection', () => {
  it('opens one exact deployment chat at a time on the Hub', async () => {
    const first = new Deployment({
      id: '00000000-0000-4000-8000-000000000002',
      name: 'First GCP box',
      kind: 'runtime.agent',
      parent_type_id: 'agent-00000000-0000-4000-8000-000000000001',
      target: { provider: 'gcp_vm', scope: 'agent-00000000-0000-4000-8000-000000000001' },
      status: { sync_state: 'current', provider_state: 'running' },
    });
    const second = new Deployment({
      id: '00000000-0000-4000-8000-000000000003',
      name: 'Second GCP box',
      kind: 'runtime.agent',
      parent_type_id: 'agent-00000000-0000-4000-8000-000000000001',
      target: { provider: 'gcp_vm', scope: 'agent-00000000-0000-4000-8000-000000000001' },
      status: { sync_state: 'current', provider_state: 'running' },
    });
    mocks.deployments = [first, second];
    const agent = new Agent({
      id: '00000000-0000-4000-8000-000000000001',
      name: 'GCP agent',
      enabled: true,
    });
    const user = userEvent.setup();

    render(<AgentDeploymentsSection agent={agent} />);

    await user.click(screen.getByTestId(`deployment-chat-${first.id}`));
    expect(screen.getByTestId('deployed-agent-chat')).toHaveTextContent('First GCP box');

    await user.click(screen.getByTestId(`deployment-chat-${second.id}`));
    expect(screen.getAllByTestId('deployed-agent-chat')).toHaveLength(1);
    expect(screen.getByTestId('deployed-agent-chat')).toHaveTextContent('Second GCP box');
  });

  it('confirms and deletes a deployment through the existing entity DELETE contract', async () => {
    const deployment = new Deployment({
      id: '00000000-0000-4000-8000-000000000002',
      name: 'GCP agent box',
      kind: 'runtime.agent',
      parent_type_id: 'agent-00000000-0000-4000-8000-000000000001',
      target: { provider: 'gcp_vm', scope: 'agent-00000000-0000-4000-8000-000000000001' },
      origin: {
        kind: 'gcp_vm',
        provider: 'gcp_vm',
        external_id: 'compute_node-00000000-0000-4000-8000-000000000003',
      },
      status: { sync_state: 'current', provider_state: 'running' },
    });
    const deleteDeployment = vi.spyOn(deployment, 'delete').mockResolvedValue(undefined);
    mocks.deployments = [deployment];
    const agent = new Agent({
      id: '00000000-0000-4000-8000-000000000001',
      name: 'GCP agent',
      enabled: true,
    });
    const user = userEvent.setup();

    render(
      <>
        <AgentDeploymentsSection agent={agent} />
        <DeleteAssetModal />
      </>,
    );

    await user.click(screen.getByRole('button', { name: 'Delete this deployment' }));
    expect(screen.getByText(/permanently destroys the deployment machine/i)).toBeInTheDocument();
    expect(deleteDeployment).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('delete-asset-modal-confirm'));

    await waitFor(() => expect(deleteDeployment).toHaveBeenCalledOnce());
    expect(mocks.refetch).toHaveBeenCalledOnce();
    expect(mocks.success).toHaveBeenCalledWith({ title: 'Deployment deleted', message: 'GCP agent box' });
  });
});
