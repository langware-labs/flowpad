import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
/**
 * New deployment: pick a type (this computer, or a cloud machine size), see what launching that
 * type needs, Launch. Only a cloud machine asks for the publish checklist and an environment.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '@sdk';
import { notify } from '@src/notifications';

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
  const onLaunched = vi.fn();
  const onOpenChange = vi.fn();
  renderInQuery(<NewDeploymentDialog agent={agent} open onOpenChange={onOpenChange} onLaunched={onLaunched} />);
  return { agent, deploy, onLaunched, onOpenChange };
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
    // A monthly row shows the machine's strength and its monthly price; every cloud row names its provider.
    expect(screen.getByTestId('new-deployment-type-gcp_vm-sm')).toHaveTextContent('2 CPU · 2 GB · $21/mo');
    expect(screen.getByTestId('new-deployment-type-gcp_vm-sm')).toHaveTextContent('Cloud machine · gcp');
    expect(screen.getByTestId('new-deployment-type-e2b-sm')).toHaveTextContent('Cloud machine · e2b');
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
    const { deploy, onLaunched } = renderDialog();
    expect(screen.getByTestId('new-deployment-local-details')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-checklist')).toBeNull();
    expect(screen.queryByTestId('new-deployment-environment')).toBeNull();
    fireEvent.click(screen.getByTestId('new-deployment-launch'));
    await waitFor(() => expect(deploy).toHaveBeenCalledWith({ provider: 'local' }));
    await waitFor(() => expect(onLaunched).toHaveBeenCalledWith('dep-1'));
  });

  it('a cloud machine shows the checklist and environment, and sends its size with the deploy', async () => {
    const { deploy } = renderDialog();
    deploy.mockResolvedValue({ deployment: { id: 'dep-2' } } as never);
    fireEvent.click(screen.getByTestId('new-deployment-type-e2b-md'));
    expect(screen.getByTestId('mock-checklist')).toBeInTheDocument();
    expect(screen.getByTestId('new-deployment-environment')).toHaveTextContent('production');
    fireEvent.click(screen.getByTestId('new-deployment-launch'));
    // Unchecked "Token allocation" = the owner's default: `null` releases any earlier allocation.
    // The size travels with the deploy; nothing is written into agent.json (it would dirty the checkout).
    await waitFor(() =>
      expect(deploy).toHaveBeenCalledWith({
        environment: 'production',
        provider: 'e2b',
        tokenAllocation: null,
        machineSize: 'md',
      }),
    );
  });

  it('a monthly machine deploys on its own provider, at its size', async () => {
    const { deploy } = renderDialog();
    fireEvent.click(screen.getByTestId('new-deployment-type-gcp_vm-lg'));
    fireEvent.click(screen.getByTestId('new-deployment-launch'));
    await waitFor(() =>
      expect(deploy).toHaveBeenCalledWith({
        environment: 'production',
        provider: 'gcp_vm',
        tokenAllocation: null,
        machineSize: 'lg',
      }),
    );
  });

  it('a cloud deploy taken on closes on the answer and says it runs in the background', async () => {
    const { deploy, onLaunched, onOpenChange } = renderDialog();
    deploy.mockResolvedValue({
      agent_id: '33333333-3333-4333-8333-333333333333',
      activity: { path: 'deploy', subject_entity: 'agent-33333333-3333-4333-8333-333333333333' },
      deployment_id: 'dep-3',
    } as never);
    fireEvent.click(screen.getByTestId('new-deployment-type-gcp_vm-sm'));
    fireEvent.click(screen.getByTestId('new-deployment-launch'));
    await waitFor(() => expect(onLaunched).toHaveBeenCalledWith('dep-3'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(notify.info).toHaveBeenCalledWith({ title: 'Deployment running in the background' });
  });

  it('this computer can always be launched again — each launch is one more process here', () => {
    renderDialog();
    expect(screen.getByTestId('new-deployment-type-local')).toBeEnabled();
    expect(screen.getByTestId('new-deployment-type-local')).toHaveAttribute('aria-checked', 'true');
  });

  it('a value typed before Launch travels with the deploy, so one Launch is enough', async () => {
    const { deploy, agent } = renderDialog();
    vi.spyOn(agent, 'deployDefaults').mockResolvedValue({ environment: 'staging', environments: ['staging'] });
    vi.spyOn(agent, 'fetchRequirements').mockResolvedValue([
      {
        kind: 'credential',
        name: 'support_team',
        vars: ['SUPPORT_TEAM_EMAILS'],
        scopes: [],
        on: '',
        why: '',
        derived: true,
        used_by: [],
      },
    ]);
    fireEvent.click(screen.getByTestId('new-deployment-type-e2b-sm'));
    fireEvent.change(await screen.findByTestId('new-deployment-value-SUPPORT_TEAM_EMAILS'), {
      target: { value: 'a@b.c' },
    });
    fireEvent.click(screen.getByTestId('new-deployment-launch'));
    await waitFor(() =>
      expect(deploy).toHaveBeenCalledWith(
        expect.objectContaining({ values: { support_team: { SUPPORT_TEAM_EMAILS: 'a@b.c' } } }),
      ),
    );
  });
});
