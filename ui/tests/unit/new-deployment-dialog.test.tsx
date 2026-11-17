import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
/**
 * New deployment — a cloud machine in two steps: billing + size (price shown once picked), Next,
 * then the setup (checklist, environment, values, tokens) and Launch. This computer is not offered.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, Project } from '@sdk';
import { notify } from '@src/notifications';

vi.mock('@src/components/assets/editor/agent-profile/AgentDeployChecklist', () => ({
  AgentDeployChecklist: () => <div data-testid="mock-checklist" />,
}));
vi.mock('@src/notifications', () => ({
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
// What the hub publishes (`deployment/providers`); each test may narrow it.
const published = vi.hoisted(() => ({ providers: ['e2b', 'gcp_vm'] as string[], isLoading: false }));
// The project's agents for the main-agent pick-list.
const projectAgents = vi.hoisted(() => ({ rows: [] as unknown[], project: null as unknown }));
// `useEntity`: the agent's project as the cache holds it (use-agent-secrets, a03b56cc0) -- the dialog's project.
vi.mock('@src/hooks/entity-hooks', () => ({
  useEntitiesQuery: () => ({ data: projectAgents.rows }),
  useEntity: () => ({ data: projectAgents.project }),
}));
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

/** Step 1: billing and size, then Next into step 2. */
function pick(billing: 'hourly' | 'monthly', size: 'sm' | 'md' | 'lg') {
  fireEvent.click(screen.getByTestId(`new-deployment-billing-${billing}`));
  fireEvent.click(screen.getByTestId(`new-deployment-size-${size}`));
  fireEvent.click(screen.getByTestId('new-deployment-next'));
}

const AGENT_ID = '33333333-3333-4333-8333-333333333333';

function renderDialog(presetMainAgentId: string | null = null, recommended: string | null = null) {
  const project = new Project({ id: '66666666-6666-4666-8666-666666666666', name: 'proj' } as never);
  projectAgents.rows = [new Agent({ id: AGENT_ID, name: 'brief', enabled: true })];
  projectAgents.project = project;
  const deploy = vi.spyOn(project, 'deploy').mockResolvedValue({ deployment: { id: 'dep-1' } } as never);
  vi.spyOn(project, 'deployDefaults').mockResolvedValue({
    environment: 'production',
    environments: ['production'],
    main_agent_id: recommended,
    source_ref: 'abc123',
  });
  const requirements = vi.spyOn(project, 'requirements').mockResolvedValue([]);
  const onLaunched = vi.fn();
  const onOpenChange = vi.fn();
  renderInQuery(
    <NewDeploymentDialog
      project={project}
      presetMainAgentId={presetMainAgentId}
      open
      onOpenChange={onOpenChange}
      onLaunched={onLaunched}
    />,
  );
  return { project, deploy, requirements, onLaunched, onOpenChange };
}

describe('New deployment', () => {
  it('step 1 offers hourly and monthly, three plain sizes, and the price only once a size is picked', () => {
    renderDialog();
    expect(screen.queryByTestId('new-deployment-type-local')).toBeNull();
    expect(screen.getByTestId('new-deployment-billing-hourly')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('new-deployment-size-md')).toHaveTextContent('Medium');
    expect(screen.getByTestId('new-deployment-size-md')).toHaveAttribute('title', '2 CPU · 4 GB');
    expect(screen.getByTestId('new-deployment-next')).toBeDisabled();
    fireEvent.click(screen.getByTestId('new-deployment-size-md'));
    expect(screen.getByTestId('new-deployment-price')).toHaveTextContent('$0.28 / hour');
    fireEvent.click(screen.getByTestId('new-deployment-billing-monthly'));
    // Switching billing clears the size: its price would be another machine's.
    expect(screen.getByTestId('new-deployment-next')).toBeDisabled();
    fireEvent.click(screen.getByTestId('new-deployment-size-lg'));
    expect(screen.getByTestId('new-deployment-price')).toHaveTextContent('$336 / month');
    expect(screen.getByTestId('new-deployment-size-lg')).toHaveAttribute('title', '8 CPU · 32 GB');
  });

  it('offers only the billings whose provider the hub publishes', () => {
    published.providers = ['e2b'];
    renderDialog();
    expect(screen.getByTestId('new-deployment-billing-hourly')).toBeInTheDocument();
    expect(screen.queryByTestId('new-deployment-billing-monthly')).toBeNull();
  });

  it('with no published provider (signed out) it says why; while loading it says so', () => {
    published.providers = [];
    renderDialog();
    expect(screen.getByTestId('new-deployment-no-cloud')).toBeInTheDocument();
    cleanup();
    published.isLoading = true;
    renderDialog();
    expect(screen.getByTestId('new-deployment-providers-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('new-deployment-no-cloud')).toBeNull();
  });

  it('step 2 shows the checklist and environment, and Launch sends the provider and size', async () => {
    const { deploy } = renderDialog();
    expect(screen.queryByTestId('mock-checklist')).toBeNull();
    pick('hourly', 'md');
    expect(screen.getByTestId('new-deployment-steps')).toHaveTextContent('Medium · $0.28 / hour');
    expect(screen.getByTestId('mock-checklist')).toBeInTheDocument();
    expect(screen.getByTestId('new-deployment-environment')).toHaveTextContent('production');
    await waitFor(() => expect(screen.getByTestId('new-deployment-source-ref')).toHaveAttribute('placeholder', 'abc123'));
    fireEvent.click(screen.getByTestId('new-deployment-launch'));
    // The size travels with the deploy; nothing is written into agent.json (it would dirty the checkout).
    await waitFor(() =>
      expect(deploy).toHaveBeenCalledWith(
        expect.objectContaining({
          environment: 'production',
          provider: 'e2b',
          tokenAllocation: null,
          machineSize: 'md',
          sourceKind: 'commit',
          sourceRef: 'abc123', // the project's HEAD, when no source is typed
          mainAgentId: null,
        }),
      ),
    );
  });

  it('a monthly machine deploys on its own provider; taken on, the dialog closes and says background', async () => {
    const { deploy, onLaunched, onOpenChange } = renderDialog();
    deploy.mockResolvedValue({ deployment_id: 'dep-3' } as never);
    pick('monthly', 'lg');
    fireEvent.click(screen.getByTestId('new-deployment-launch'));
    await waitFor(() => expect(onLaunched).toHaveBeenCalledWith('dep-3'));
    expect(deploy).toHaveBeenCalledWith(expect.objectContaining({ provider: 'gcp_vm', machineSize: 'lg' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(notify.info).toHaveBeenCalledWith({ title: 'Deployment running in the background' });
  });

  it('Back returns to step 1 with the pick kept', () => {
    renderDialog();
    pick('hourly', 'sm');
    fireEvent.click(screen.getByTestId('new-deployment-back'));
    expect(screen.getByTestId('new-deployment-size-sm')).toHaveAttribute('aria-checked', 'true');
  });

  it('a value typed before Launch travels with the deploy, so one Launch is enough', async () => {
    const { deploy, requirements } = renderDialog();
    requirements.mockResolvedValue([
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
    pick('hourly', 'sm');
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

  it('the main agent is the preset, else the project recommendation, and can be none', async () => {
    const { deploy } = renderDialog(AGENT_ID);
    pick('hourly', 'sm');
    expect(screen.getByTestId('new-deployment-main-agent')).toHaveTextContent('brief');
    fireEvent.click(screen.getByTestId('new-deployment-launch'));
    await waitFor(() => expect(deploy).toHaveBeenCalledWith(expect.objectContaining({ mainAgentId: `agent-${AGENT_ID}` })));
    cleanup();
    const second = renderDialog(null, `agent-${AGENT_ID}`);
    pick('hourly', 'sm');
    await waitFor(() => expect(screen.getByTestId('new-deployment-main-agent')).toHaveTextContent('brief'));
    cleanup();
    const none = renderDialog();
    pick('hourly', 'sm');
    expect(screen.getByTestId('new-deployment-main-agent')).toHaveTextContent('No agent');
    void second;
    void none;
  });

  it('a tag source names its ref; Launch waits for one', async () => {
    const { deploy } = renderDialog();
    pick('hourly', 'sm');
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.releasePointerCapture = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByTestId('new-deployment-source-kind'));
    await userEvent.click(screen.getByRole('option', { name: 'Tag' }));
    expect(screen.getByTestId('new-deployment-launch')).toBeDisabled();
    fireEvent.change(screen.getByTestId('new-deployment-source-ref'), { target: { value: 'v1.2' } });
    fireEvent.click(screen.getByTestId('new-deployment-launch'));
    await waitFor(() =>
      expect(deploy).toHaveBeenCalledWith(expect.objectContaining({ sourceKind: 'tag', sourceRef: 'v1.2' })),
    );
  });
});
