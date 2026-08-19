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
