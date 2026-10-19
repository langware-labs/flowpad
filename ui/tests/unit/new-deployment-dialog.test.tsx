import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
/**
 * New deployment: pick a type (this computer, or a cloud machine size), see what launching that
 * type needs, Launch. Only a cloud machine asks for the publish checklist and an environment.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '@sdk';

vi.mock('@src/components/assets/editor/agent-profile/AgentDeployChecklist', () => ({
  AgentDeployChecklist: () => <div data-testid="mock-checklist" />,
}));
vi.mock('@src/notifications', () => ({
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
// What the hub publishes (`deployment/providers`); each test may narrow it.
const published = vi.hoisted(() => ({ providers: ['e2b', 'gcp_vm'] as string[], isLoading: false }));
vi.mock('@src/hooks/use-deploy-providers', () => ({ useDeployProviders: () => published }));

import { NewDeploymentDialog } from '@src/components/assets/editor/agent-profile/NewDeploymentDialog';

function renderInQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  published.providers = ['e2b', 'gcp_vm'];
  published.isLoading = false;
});

const radios = () => screen.getAllByRole('radio').map((r) => r.getAttribute('data-testid'));

function renderDialog() {
  const agent = new Agent({ id: '33333333-3333-4333-8333-333333333333', name: 'brief', enabled: true });
  const deploy = vi.spyOn(agent, 'deploy').mockResolvedValue({ deployment: { id: 'dep-1' } } as never);
  const onMachineSize = vi.fn().mockResolvedValue(true);
  const onLaunched = vi.fn();
  const onOpenChange = vi.fn();
  renderInQuery(
    <NewDeploymentDialog
      agent={agent}
      open
      onOpenChange={onOpenChange}
      onMachineSize={onMachineSize}
      onLaunched={onLaunched}
    />,
  );
  return { deploy, onMachineSize, onLaunched, onOpenChange };
}

describe('New deployment', () => {
  it('offers this computer, then every size billed hourly, then every size billed monthly', () => {
    renderDialog();
    const types = screen.getAllByRole('radio').map((r) => r.getAttribute('data-testid'));
    expect(types).toEqual([
      'new-deployment-type-local',
      'new-deployment-type-e2b-sm',
      'new-deployment-type-e2b-md',
      'new-deployment-type-e2b-lg',
      'new-deployment-type-gcp_vm-sm',
      'new-deployment-type-gcp_vm-md',
      'new-deployment-type-gcp_vm-lg',
    ]);
    expect(screen.getByTestId('new-deployment-type-local')).toHaveAttribute('aria-checked', 'true');
    // A monthly row shows the machine's strength and its monthly price, never which provider runs it.
    expect(screen.getByTestId('new-deployment-type-gcp_vm-sm')).toHaveTextContent('2 CPU · 2 GB · $21/mo');
    expect(screen.getByTestId('new-deployment-type-gcp_vm-sm')).not.toHaveTextContent(/gcp/i);
  });

  it('offers cloud machines only on the providers the hub publishes', () => {
    published.providers = ['e2b'];
    renderDialog();
    expect(radios()).toEqual([
      'new-deployment-type-local',
      'new-deployment-type-e2b-sm',
      'new-deployment-type-e2b-md',
      'new-deployment-type-e2b-lg',
    ]);
  });

  it('with no published provider (signed out) only this computer is offered, and says why', () => {
    published.providers = [];
    renderDialog();
    expect(radios()).toEqual(['new-deployment-type-local']);
    expect(screen.getByTestId('new-deployment-no-cloud')).toBeInTheDocument();
  });

  it('while the providers load, this computer is offered and the cloud rows are pending', () => {
    published.providers = [];
    published.isLoading = true;
    renderDialog();
    expect(radios()).toEqual(['new-deployment-type-local']);
    expect(screen.getByTestId('new-deployment-providers-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('new-deployment-no-cloud')).toBeNull();
  });

  it('this computer needs no publish checklist and no environment — Launch deploys it here', async () => {
    const { deploy, onMachineSize, onLaunched } = renderDialog();
    expect(screen.getByTestId('new-deployment-local-details')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-checklist')).toBeNull();
    expect(screen.queryByTestId('new-deployment-environment')).toBeNull();
    fireEvent.click(screen.getByTestId('new-deployment-launch'));
    await waitFor(() => expect(deploy).toHaveBeenCalledWith(undefined, 'local'));
    expect(onMachineSize).not.toHaveBeenCalled();
    await waitFor(() => expect(onLaunched).toHaveBeenCalledWith('dep-1'));
  });

  it('a cloud machine shows the checklist and environment, and saves its size before deploying', async () => {
    const order: string[] = [];
    const { deploy, onMachineSize } = renderDialog();
    onMachineSize.mockImplementation(async () => order.push('size'));
    deploy.mockImplementation(async () => {
      order.push('deploy');
      return { deployment: { id: 'dep-2' } } as never;
    });
    fireEvent.click(screen.getByTestId('new-deployment-type-e2b-md'));
    expect(screen.getByTestId('mock-checklist')).toBeInTheDocument();
    expect(screen.getByTestId('new-deployment-environment')).toHaveValue('production');
    fireEvent.click(screen.getByTestId('new-deployment-launch'));
    // Unchecked "Token allocation" = the owner's default: `null` releases any earlier allocation.
    await waitFor(() => expect(deploy).toHaveBeenCalledWith('production', 'e2b', null));
    expect(onMachineSize).toHaveBeenCalledWith('md');
    expect(order).toEqual(['size', 'deploy']);
  });

  it('a monthly machine deploys on its own provider, at its size', async () => {
    const { deploy, onMachineSize } = renderDialog();
    fireEvent.click(screen.getByTestId('new-deployment-type-gcp_vm-lg'));
    fireEvent.click(screen.getByTestId('new-deployment-launch'));
    await waitFor(() => expect(deploy).toHaveBeenCalledWith('production', 'gcp_vm', null));
    expect(onMachineSize).toHaveBeenCalledWith('lg');
  });

  it('this computer can always be launched again — each launch is one more process here', () => {
    renderDialog();
    expect(screen.getByTestId('new-deployment-type-local')).toBeEnabled();
    expect(screen.getByTestId('new-deployment-type-local')).toHaveAttribute('aria-checked', 'true');
  });
});
