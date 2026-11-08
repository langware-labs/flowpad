/**
 * The agent's Env tab: one row per variable with its kind, status, the Inject switch (the approval) and
 * "placed on N of M"; Add approves a declared credential into the Env; Flowpad's own variables are listed
 * read-only. The deployment's Environment view shows where each variable comes from, and Override / Reset.
 * The SDK calls go where the hub interface says (`save_env`, `env-var`, `environment`).
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/notifications', () => ({
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const { Agent, Deployment, Project, credentialsService, dataManager } = await import('@sdk');
const { AgentEnvTab } = await import('@src/components/assets/editor/agent-profile/AgentEnvTab');
const { AgentPlaceSecrets } = await import('@src/components/assets/editor/agent-profile/AgentPlaceSecrets');
type ActionInfo = import('@sdk').ActionInfo;

const AGENT_ID = '11111111-2222-4333-8444-555555555555';
const DEPLOYMENT_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const DEPLOYMENT_ROW = {
  id: DEPLOYMENT_ID,
  name: 'd',
  environment: 'production',
  target: { provider: 'e2b', scope: 'machine', location: null },
  status: { sync_state: 'current', provider_state: 'running' },
};

const ENV = {
  entries: [
    { name: 'WEATHER_KEY', kind: 'secret', description: 'Weather API', inject: true, written: true },
    { name: 'DRAFT_KEY', kind: 'secret', description: '', inject: false, written: false },
    { name: 'REGION', kind: 'plain', description: '', inject: true, written: true, value: 'eu' },
  ],
  system: [{ name: 'ANTHROPIC_BASE_URL', provided_by: 'llm_endpoint', description: 'Your LLM endpoint' }],
  placements: [
    { target: 'deployment-1', kind: 'deployment', placed: ['WEATHER_KEY', 'REGION'], at: '' },
    { target: 'compute_node-2', kind: 'invite', placed: ['REGION'], at: '' },
  ],
};

const STATUS = {
  project_id: PROJECT_ID,
  deployment_id: '',
  environment: 'development',
  deployments: [],
  vault_enabled: false,
  files: [],
  credentials: [
    {
      name: 'stripe',
      title: 'Stripe',
      vars: [
        { env_var: 'STRIPE_KEY', secret: true, kind: 'value' },
        { env_var: 'WEATHER_KEY', secret: true, kind: 'value' },
      ],
    },
  ],
};

let calls: ActionInfo[];
let callAction: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  calls = [];
  callAction = vi.spyOn(dataManager, 'callAction').mockImplementation((info: ActionInfo) => {
    calls.push(info);
    if (info.fullActionUrl.endsWith('/env') || info.fullActionUrl.endsWith('/save_env')) return Promise.resolve(ENV);
    return Promise.resolve({});
  });
  vi.spyOn(credentialsService, 'status').mockResolvedValue(STATUS as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const agent = () => new Agent({ id: AGENT_ID, name: 'envy', project_id: PROJECT_ID, remote: true } as never);
const last = (suffix: string) => [...calls].reverse().find((c) => c.fullActionUrl.endsWith(suffix));

describe('the Env tab', () => {
  it('lists each variable with its kind, status, approval and placements', async () => {
    render(<AgentEnvTab agent={agent()} />);

    expect(await screen.findByTestId('agent-env-row-WEATHER_KEY')).toBeInTheDocument();
    expect(screen.getByTestId('agent-env-kind-WEATHER_KEY')).toHaveTextContent('Secret');
    expect(screen.getByTestId('agent-env-kind-REGION')).toHaveTextContent('Plain');
    expect(screen.getByTestId('agent-env-status-WEATHER_KEY')).toHaveTextContent('Set');
    expect(screen.getByTestId('agent-env-status-DRAFT_KEY')).toHaveTextContent('Not set');
    expect(screen.getByTestId('agent-env-inject-WEATHER_KEY')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByTestId('agent-env-inject-DRAFT_KEY')).toHaveAttribute('data-state', 'unchecked');
    expect(screen.getByTestId('agent-env-placed-WEATHER_KEY')).toHaveTextContent('placed on 1 of 2');
    expect(screen.getByTestId('agent-env-placed-REGION')).toHaveTextContent('placed on 2 of 2');
    expect(screen.queryByTestId('agent-env-use-mine-REGION')).toBeNull(); // a plain value is typed, not copied
  });

  it('approves an entry with the Inject switch and saves the whole Env', async () => {
    render(<AgentEnvTab agent={agent()} />);
    fireEvent.click(await screen.findByTestId('agent-env-inject-DRAFT_KEY'));

    await waitFor(() => expect(last('/save_env')).toBeDefined());
    const body = last('/save_env')!.bodyParameters as { entries: { name: string; inject: boolean; value?: string }[] };
    expect(body.entries.find((e) => e.name === 'DRAFT_KEY')?.inject).toBe(true);
    expect(body.entries.find((e) => e.name === 'REGION')?.value).toBe('eu');
    expect(body.entries.find((e) => e.name === 'WEATHER_KEY')).not.toHaveProperty('value');
  });

  it('adds a declared credential the Env does not hold yet, approved', async () => {
    render(<AgentEnvTab agent={agent()} />);
    fireEvent.click(await screen.findByTestId('agent-env-add'));

    expect(screen.queryByTestId('agent-env-add-pick-WEATHER_KEY')).toBeNull(); // already in the Env
    fireEvent.click(await screen.findByTestId('agent-env-add-pick-STRIPE_KEY'));

    await waitFor(() => expect(last('/save_env')).toBeDefined());
    const body = last('/save_env')!.bodyParameters as { entries: { name: string; kind: string; inject: boolean }[] };
    expect(body.entries.at(-1)).toEqual({ name: 'STRIPE_KEY', kind: 'secret', description: '', inject: true });
  });

  it('sets a secret on the hub, write-only', async () => {
    render(<AgentEnvTab agent={agent()} />);
    fireEvent.click(await screen.findByTestId('agent-env-set-WEATHER_KEY'));
    fireEvent.change(screen.getByTestId('agent-env-value-WEATHER_KEY'), { target: { value: 'sk-new' } });
    fireEvent.click(screen.getByTestId('agent-env-save-WEATHER_KEY'));

    await waitFor(() => expect(last('/env-var')).toBeDefined());
    const info = last('/env-var')!;
    expect(info.method).toBe('POST');
    expect(info.hubReflect).toBe(true);
    expect(info.bodyParameters).toEqual({ name: 'WEATHER_KEY', value: 'sk-new', var_type: 'api_key' });
  });

  it('lists what Flowpad provides, read-only', async () => {
    render(<AgentEnvTab agent={agent()} />);
    fireEvent.click(await screen.findByTestId('agent-env-system-toggle'));
    expect(await screen.findByTestId('agent-env-system-ANTHROPIC_BASE_URL')).toHaveTextContent('Your LLM endpoint');
    expect(screen.queryByTestId('agent-env-row-ANTHROPIC_BASE_URL')).toBeNull();
  });
});

describe('the SDK calls', () => {
  it('forgets a secret and a deployment override with DELETE env-var/<NAME> on the hub', async () => {
    await agent().forgetEnv('WEATHER_KEY');
    const deployment = new Deployment(DEPLOYMENT_ROW as never);
    await deployment.forget('WEATHER_KEY');

    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes.map((c) => c.fullActionUrl)).toEqual([
      expect.stringMatching(new RegExp(`agent/${AGENT_ID}/env-var/WEATHER_KEY$`)),
      expect.stringMatching(new RegExp(`deployment/${DEPLOYMENT_ID}/env-var/WEATHER_KEY$`)),
    ]);
    expect(deletes.every((c) => c.hubReflect)).toBe(true);
  });

  it('reads a deployment environment from GET deployment/<id>/environment', async () => {
    callAction.mockImplementationOnce((info: ActionInfo) => {
      calls.push(info);
      return Promise.resolve({ rows: [{ name: 'A', kind: 'secret', source: 'agent', written: true }] });
    });
    const rows = await new Deployment(DEPLOYMENT_ROW as never).environmentRows();
    expect(rows).toEqual([{ name: 'A', kind: 'secret', source: 'agent', written: true }]);
    expect(calls[0].fullActionUrl).toMatch(new RegExp(`deployment/${DEPLOYMENT_ID}/environment$`));
  });
});

describe('the deployment Environment view', () => {
  const ROWS = [
    { name: 'WEATHER_KEY', kind: 'secret', source: 'agent', written: true },
    { name: 'REGION', kind: 'plain', source: 'deployment', written: true },
    { name: 'ANTHROPIC_BASE_URL', kind: 'plain', source: 'flowpad', written: true },
  ];

  const view = () => {
    const deployment = new Deployment(DEPLOYMENT_ROW as never);
    const project = new Project({ id: PROJECT_ID, name: 'p' } as never);
    vi.spyOn(project, 'readiness').mockResolvedValue({
      agent_id: '',
      deployment_id: DEPLOYMENT_ID,
      environment: 'production',
      ready: true,
      items: [],
    });
    vi.spyOn(deployment, 'secretsInventory').mockResolvedValue({ secrets: [], authorizations: [] });
    vi.spyOn(deployment, 'environmentRows').mockResolvedValue(ROWS as never);
    render(<AgentPlaceSecrets project={project} deployment={deployment} />);
    return deployment;
  };

  it('shows where each variable comes from, with Override and Reset only where they apply', async () => {
    view();
    expect(await screen.findByTestId('deployment-env-source-WEATHER_KEY')).toHaveTextContent('From the agent');
    expect(screen.getByTestId('deployment-env-source-REGION')).toHaveTextContent('This deployment');
    expect(screen.getByTestId('deployment-env-source-ANTHROPIC_BASE_URL')).toHaveTextContent('Provided by Flowpad');
    expect(screen.getByTestId('deployment-env-override-WEATHER_KEY')).toBeInTheDocument();
    expect(screen.queryByTestId('deployment-env-reset-WEATHER_KEY')).toBeNull();
    expect(screen.getByTestId('deployment-env-reset-REGION')).toBeInTheDocument();
    expect(screen.queryByTestId('deployment-env-override-ANTHROPIC_BASE_URL')).toBeNull();
  });

  it('overrides through the credential that declares the variable, and resets with forget', async () => {
    const setByName = vi.spyOn(credentialsService, 'setByName').mockResolvedValue({} as never);
    const deployment = view();
    const forget = vi.spyOn(deployment, 'forget').mockResolvedValue();

    fireEvent.click(await screen.findByTestId('deployment-env-override-WEATHER_KEY'));
    fireEvent.change(screen.getByTestId('deployment-env-override-value-WEATHER_KEY'), { target: { value: 'sk-here' } });
    fireEvent.click(screen.getByTestId('deployment-env-override-save-WEATHER_KEY'));
    await waitFor(() =>
      expect(setByName).toHaveBeenCalledWith('stripe', { WEATHER_KEY: 'sk-here' }, PROJECT_ID, DEPLOYMENT_ID),
    );

    fireEvent.click(await screen.findByTestId('deployment-env-reset-REGION'));
    await waitFor(() => expect(forget).toHaveBeenCalledWith('REGION'));
  });
});
