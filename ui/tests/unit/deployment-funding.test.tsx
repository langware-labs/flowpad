/**
 * A deployment's funding, as the hub answers it: who pays (its own allocation, or its owner's default),
 * the size it runs and the model that is, and — when the next turn cannot be paid for — a red card and a
 * notification, never a silent empty state.
 */
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), open: vi.fn() }));
vi.mock('@src/notifications', () => ({ notify: { error: h.error, success: h.success, info: vi.fn() } }));
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => ({ navigation: {} }) }));
vi.mock('@src/components/llm-endpoints/llm-endpoints-pointer', () => ({ openLlmEndpoint: h.open }));
vi.mock('@src/components/assets/editor/agent-profile/TokenAllocationField', () => ({
  TokenAllocationField: () => <div data-testid="allocation-field" />,
  tokenAllocationComplete: () => true,
}));

import { Agent, Deployment, type DeploymentFunding } from '@sdk';

import {
  DeploymentFundingCard,
  FundedBy,
} from '@src/components/assets/editor/agent-profile/deployment/DeploymentFunding';

const agent = new Agent({ id: '33333333-3333-4333-8333-333333333333', name: 'Procurement agent' } as never);

function deployment(funding: DeploymentFunding): Deployment {
  const d = new Deployment({
    id: '44444444-4444-4444-8444-444444444444',
    name: 'Procurement (gcp_vm)',
    target: { provider: 'gcp_vm', scope: 'production' },
  } as never);
  d.funding = () => Promise.resolve(funding);
  return d;
}

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const ALLOCATION: DeploymentFunding = {
  kind: 'allocation',
  endpoint_typeid: 'llm_endpoint-55555555-5555-4555-8555-555555555555',
  name: 'Procurement (gcp_vm) tokens',
  size: 'lg',
  model: 'google/gemini-3.1-pro-preview',
  exhausted: '',
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('deployment funding', () => {
  it('names the allocation and the model its size runs', async () => {
    wrap(<DeploymentFundingCard agent={agent} deployment={deployment(ALLOCATION)} />);
    expect(await screen.findByTestId('deployment-funding-source')).toHaveTextContent('Procurement (gcp_vm) tokens');
    expect(screen.getByTestId('deployment-funding-model')).toHaveTextContent('lg → google/gemini-3.1-pro-preview');
    expect(screen.queryByTestId('deployment-funding-problem')).toBeNull();
    expect(h.error).not.toHaveBeenCalled();
  });

  it('a turn it cannot pay for turns the card red and notifies once', async () => {
    const refused = { ...ALLOCATION, exhausted: "model size 'lg': no endpoint on the chain declares a 'lg' model" };
    const { rerender } = wrap(<DeploymentFundingCard agent={agent} deployment={deployment(refused)} />);
    expect(await screen.findByTestId('deployment-funding-problem')).toHaveTextContent("declares a 'lg' model");
    await waitFor(() => expect(h.error).toHaveBeenCalledTimes(1));
    expect(h.error.mock.calls[0][0].message).toContain("'lg'");
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <DeploymentFundingCard agent={agent} deployment={deployment(refused)} />
      </QueryClientProvider>,
    );
    expect(h.error).toHaveBeenCalledTimes(1);
  });

  it('the list cell says who pays, and an owner default says so', async () => {
    wrap(
      <FundedBy
        deployment={deployment({ kind: 'default', endpoint_typeid: 'x', name: 'eran default', exhausted: '' })}
      />,
    );
    expect(await screen.findByTestId('funded-by-44444444-4444-4444-8444-444444444444')).toHaveTextContent(
      'eran default (owner default)',
    );
  });
});
