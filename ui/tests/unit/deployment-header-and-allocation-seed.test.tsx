/**
 * A deployment's header names the model its funding runs (not the agent's own size), and "Change allocation"
 * opens on the allocation the deployment HAS — read back from its endpoint chain — so saving it untouched
 * keeps that allocation instead of sending `null` (which drops it).
 */
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ENTRY = '55555555-5555-4555-8555-555555555555';
const PARENT = '66666666-6666-4666-8666-666666666666';
const DEPLOYMENT_ID = '44444444-4444-4444-8444-444444444444';

const h = vi.hoisted(() => ({ chain: vi.fn(), deployment: null as unknown, agent: null as unknown }));
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() }, currentDock: null }),
}));
vi.mock('@src/components/llm-endpoints/use-llm-endpoints', () => ({
  useLlmEndpointChain: (id: string | undefined) => h.chain(id),
  useLlmEndpointModels: () => ({ data: [], isLoading: false }),
  useLlmEndpoints: () => ({
    endpoints: [{ id: PARENT, name: 'eran@langware.ai default', canAllocate: true }],
    isLoading: false,
  }),
}));
vi.mock('@sdk/react/hooks', async (original) => ({
  ...(await original<object>()),
  useEntity: (typeId: { type?: string } | null) => ({ data: typeId?.type === 'agent' ? h.agent : h.deployment }),
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
vi.mock('@src/components/project-deployments/ProjectDeploymentCard', () => ({ ProjectDeploymentCard: () => null }));

const { Agent, Deployment, Project } = await import('@sdk');
type DeploymentFunding = import('@sdk').DeploymentFunding;
type LLMChain = import('@sdk').LLMChain;
const { allocationFromChain } = await import('@src/components/assets/editor/agent-profile/TokenAllocationField');
const { DeploymentFundingCard } =
  await import('@src/components/assets/editor/agent-profile/deployment/DeploymentFunding');
const { ProjectDeploymentPage } = await import('@src/components/project-deployments/ProjectDeploymentPage');

const FUNDING: DeploymentFunding = {
  kind: 'allocation',
  endpoint_typeid: `llm_endpoint-${ENTRY}`,
  name: 'Procurement (gcp_vm) tokens',
  size: 'sm',
  model: 'google/gemini-3.1-pro-preview',
  exhausted: '',
};

const hop = (id: string, extra: object) => ({
  id,
  name: id,
  provider: null,
  is_root: false,
  has_credential: false,
  enabled: true,
  breaker: { state: 'closed', open_until: null },
  remaining: {},
  ...extra,
});

// The hub's chain for the deployment's allocation: entry (its own cap + model) → the budget it is carved from.
const CHAIN = {
  entry: { id: `llm_endpoint-${ENTRY}`, name: 'Procurement (gcp_vm) tokens' },
  hops: [
    hop(`llm_endpoint-${ENTRY}`, {
      limits: { cost_usd_per_day: 6 },
      effective_filters: { models_allow: ['google/gemini-3.1-pro-preview'] },
    }),
    hop(`llm_endpoint-${PARENT}`, { limits: {}, effective_filters: { models_allow: [] } }),
  ],
  paths: [[`llm_endpoint-${ENTRY}`, `llm_endpoint-${PARENT}`]],
  missing_sources: [],
  sticky_root_for_me: null,
} as unknown as LLMChain;

const project = new Project({ id: '77777777-7777-4777-8777-777777777777', name: 'proj' } as never);
const agent = new Agent({
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Procurement agent',
  worker_type: 'claude',
  model: 'sm',
} as never);

function deployment(funding: DeploymentFunding) {
  const d = new Deployment({
    id: DEPLOYMENT_ID,
    name: 'Procurement (gcp_vm)',
    environment: 'production',
    target: { provider: 'gcp_vm', scope: 'production' },
    main_agent_id: 'agent-33333333-3333-4333-8333-333333333333',
  } as never);
  d.funding = () => Promise.resolve(funding);
  return d;
}

const wrap = (ui: React.ReactElement) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {ui}
    </QueryClientProvider>,
  );

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  h.chain.mockReset();
});

describe('allocationFromChain', () => {
  it("reads the source (entry's parent), the daily cap and the model off the entry hop", () => {
    expect(allocationFromChain(CHAIN, FUNDING)).toEqual({
      source: `llm_endpoint-${PARENT}`,
      cost_usd_per_day: 6,
      model: 'google/gemini-3.1-pro-preview',
    });
  });

  it('is null when the deployment has no allocation of its own', () => {
    expect(allocationFromChain(CHAIN, { ...FUNDING, kind: 'default' })).toBeNull();
  });

  it("falls back to the funding's model when the entry pins none", () => {
    const loose = { ...CHAIN, hops: [hop(`llm_endpoint-${ENTRY}`, { limits: {}, effective_filters: {} })] };
    expect(allocationFromChain(loose as unknown as LLMChain, FUNDING)?.model).toBe('google/gemini-3.1-pro-preview');
  });
});

describe('deployment header', () => {
  it('names the harness and the model its funding runs, not the agent size', async () => {
    h.chain.mockReturnValue({ data: undefined });
    h.deployment = deployment(FUNDING);
    h.agent = agent;
    wrap(<ProjectDeploymentPage project={project} deploymentId={DEPLOYMENT_ID} />);
    const header = screen.getByRole('heading', { level: 1 }).parentElement as HTMLElement;
    await waitFor(() =>
      expect(header).toHaveTextContent('Procurement agent · Claude · sm → google/gemini-3.1-pro-preview'),
    );
  });
});

describe('Change allocation', () => {
  it('opens on the current allocation, and saving it untouched keeps it', async () => {
    h.chain.mockReturnValue({ data: CHAIN, error: null });
    const plan = vi.spyOn(project, 'planDeployment').mockResolvedValue({} as never);
    wrap(<DeploymentFundingCard project={project} agent={agent} deployment={deployment(FUNDING)} />);
    fireEvent.click(await screen.findByTestId('deployment-change-allocation'));

    expect(await screen.findByTestId('token-allocation-toggle')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByTestId('token-allocation-source')).toHaveValue(`llm_endpoint-${PARENT}`);
    expect(screen.getByTestId('token-allocation-budget')).toHaveValue(6);
    expect(h.chain).toHaveBeenCalledWith(ENTRY);

    fireEvent.click(screen.getByTestId('deployment-allocation-save'));
    await waitFor(() => expect(plan).toHaveBeenCalled());
    expect(plan.mock.calls[0][0]?.tokenAllocation).toEqual({
      source: `llm_endpoint-${PARENT}`,
      cost_usd_per_day: 6,
      model: 'google/gemini-3.1-pro-preview',
    });
  });
});
