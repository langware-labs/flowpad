/**
 * A cloud deploy refused with `not_ready` lists what the placement's machine lacks; "Use mine" and
 * "Authorize" fix an item and re-plan (the hub's answer, never a local guess). The Secrets tab lists
 * what the hub holds — names only — and revokes a connection.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, Deployment, credentialsService, type AgentReadiness, type AgentReadinessItem } from '@sdk';

vi.mock('@src/notifications', () => ({
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('@src/components/assets/editor/agent-profile/AgentDeployChecklist', () => ({
  AgentDeployChecklist: () => <div data-testid="mock-checklist" />,
}));

import { NewDeploymentDialog } from '@src/components/assets/editor/agent-profile/NewDeploymentDialog';
import { AgentPlaceSecrets } from '@src/components/assets/editor/agent-profile/AgentPlaceSecrets';
import { DeploymentSecretsGate } from '@src/components/assets/editor/agent-profile/DeploymentSecretsGate';

const DEPLOYMENT = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'brief (production)',
  kind: 'runtime.agent',
  environment: 'production',
  target: { provider: 'e2b', scope: 'machine', location: null },
  status: { sync_state: 'current', provider_state: 'planned' },
};

function item(name: string, extra: Partial<AgentReadinessItem> = {}): AgentReadinessItem {
  return {
    requirement: {
      kind: 'credential',
      name,
      vars: [],
      scopes: [],
      on: '',
      why: '',
      derived: true,
      used_by: [],
    },
    status: 'missing',
    where: 'hub',
    vars: [],
    missing: [],
    connection: '',
    fix: `flow credentials set ${name} --stdin`,
    remedy: 'use_mine',
    ...extra,
  };
}

function readiness(items: AgentReadinessItem[]): AgentReadiness {
  return {
    agent_id: 'a',
    deployment_id: DEPLOYMENT.id,
    environment: 'production',
    ready: items.every((i) => i.status !== 'missing'),
    items,
  };
}

const agent = () => new Agent({ id: '33333333-3333-4333-8333-333333333333', name: 'brief', enabled: true });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the deploy gate', () => {
  it('"Use mine" copies the item\'s variables into the planned placement and shows the hub\'s new answer', async () => {
    const stripe = item('stripe', { vars: ['STRIPE_KEY'], missing: ['STRIPE_KEY'] });
    const a = agent();
    const asked = vi
      .spyOn(a, 'readiness')
      .mockResolvedValue(readiness([{ ...stripe, status: 'declared', where: 'hub' }]));
    const useMine = vi
      .spyOn(credentialsService, 'useMine')
      .mockResolvedValue({ copied: ['STRIPE_KEY'], not_here: [], hub_funded: [] });
    const onChange = vi.fn();

    render(
      <DeploymentSecretsGate
        agent={a}
        deployment={new Deployment(DEPLOYMENT as never)}
        readiness={readiness([stripe])}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('deployment-secret-use-mine-stripe'));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ ready: true })));
    expect(useMine).toHaveBeenCalledWith(DEPLOYMENT.id, ['STRIPE_KEY']);
    expect(asked).toHaveBeenCalledWith(DEPLOYMENT.id);
  });

  it('a value this computer lacks too says so and offers no "Use mine" again', async () => {
    const stripe = item('stripe', { vars: ['STRIPE_KEY'], missing: ['STRIPE_KEY'] });
    const a = agent();
    vi.spyOn(a, 'readiness').mockResolvedValue(readiness([stripe]));
    vi.spyOn(credentialsService, 'useMine').mockResolvedValue({ copied: [], not_here: ['STRIPE_KEY'], hub_funded: [] });

    render(
      <DeploymentSecretsGate
        agent={a}
        deployment={new Deployment(DEPLOYMENT as never)}
        readiness={readiness([stripe])}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('deployment-secret-use-mine-stripe'));

    await waitFor(() =>
      expect(screen.getByTestId('deployment-secret-stripe')).toHaveTextContent('Not on this computer either'),
    );
    expect(screen.queryByTestId('deployment-secret-use-mine-stripe')).toBeNull();
  });

  it('a connection held here but not granted to that machine is authorized for it', async () => {
    const drive = item('permission.google.drive.read', {
      requirement: { ...item('x').requirement, kind: 'permission', name: 'permission.google.drive.read' },
      connection: 'google',
      fix: 'authorize google for this deployment',
      remedy: 'authorize',
    });
    const a = agent();
    vi.spyOn(a, 'readiness').mockResolvedValue(readiness([drive]));
    const authorize = vi.spyOn(Deployment.prototype, 'authorize').mockResolvedValue();

    render(
      <DeploymentSecretsGate
        agent={a}
        deployment={new Deployment(DEPLOYMENT as never)}
        readiness={readiness([drive])}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('deployment-secret-authorize-permission.google.drive.read'));

    await waitFor(() => expect(authorize).toHaveBeenCalledWith('google', ['permission.google.drive.read']));
  });
});

describe('the Secrets tab', () => {
  it('lists what the hub holds and revokes a connection', async () => {
    const deployment = new Deployment(DEPLOYMENT as never);
    const a = agent();
    vi.spyOn(a, 'readiness').mockResolvedValue(readiness([]));
    const inventory = vi.spyOn(deployment, 'secretsInventory').mockResolvedValue({
      secrets: [{ name: 'STRIPE_KEY', written: 1_790_000_000, placed: { ts: 1_790_000_100, event: 'placed' } }],
      authorizations: [{ provider: 'google', permissions: ['permission.google.drive.read'] }],
    });
    const revoke = vi.spyOn(deployment, 'revoke').mockResolvedValue();

    render(<AgentPlaceSecrets agent={a} deployment={deployment} />);

    expect(await screen.findByTestId('agent-place-secret-STRIPE_KEY')).toHaveTextContent('placed');
    expect(screen.queryByTestId('deployment-secrets-gate')).toBeNull();
    fireEvent.click(screen.getByTestId('agent-place-revoke-google'));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('google'));
    expect(inventory).toHaveBeenCalledTimes(2);
  });
});

describe('the new deployment dialog', () => {
  it('a Launch refused as not ready lists what is missing and keeps Launch off until it is fixed', async () => {
    const a = agent();
    const refusal = {
      response: {
        status: 409,
        data: {
          data: {
            code: 'not_ready',
            readiness: readiness([item('stripe', { vars: ['STRIPE_KEY'], missing: ['STRIPE_KEY'] })]),
            deployment: DEPLOYMENT,
          },
        },
      },
    };
    const deploy = vi.spyOn(a, 'deploy').mockRejectedValue(refusal);
    const onLaunched = vi.fn();

    render(<NewDeploymentDialog agent={a} open onOpenChange={vi.fn()} onLaunched={onLaunched} />);
    fireEvent.click(screen.getByTestId('new-deployment-type-sm'));
    fireEvent.click(screen.getByTestId('new-deployment-launch'));

    expect(await screen.findByTestId('deployment-secret-stripe')).toHaveTextContent('flow credentials set stripe');
    expect(deploy).toHaveBeenCalledWith('production', undefined, null);
    expect(screen.getByTestId('new-deployment-launch')).toBeDisabled();
    expect(onLaunched).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('new-deployment-environment'), { target: { value: 'staging' } });
    expect(screen.queryByTestId('deployment-secrets-gate')).toBeNull();
  });
});
