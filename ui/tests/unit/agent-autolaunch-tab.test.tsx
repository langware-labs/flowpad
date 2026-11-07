/**
 * The agent's Auto-launch tab: it reads `public_deployments` from the hub and shows the saved settings,
 * the open link and each visitor's box; an unpublished agent is told to publish first.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/components/llm-sources/use-llm-sources', () => ({
  useLlmSources: () => ({ status: { available: [] }, isLoading: false }),
}));

const { Agent, cloudManager, dataManager } = await import('@sdk');
const { AgentAutoLaunchTab } = await import('@src/components/assets/editor/agent-profile/AgentAutoLaunchTab');
type AgentVersionState = import('@sdk').AgentVersionState;

const AGENT_ID = '11111111-2222-4333-8444-555555555555';
const HUB = 'https://staging.flowpad.ai';
const PUBLISHED: AgentVersionState = {
  published: true,
  published_commit: 'deadbeef',
  has_repo: true,
  pending_changes: 0,
};
const UNPUBLISHED: AgentVersionState = { published: false, published_commit: '', has_repo: true, pending_changes: 1 };

const PAYLOAD = {
  settings: {
    allow_visitor_deployment: true,
    mode: 'code',
    max_deployments: 3,
    wrong_code_limit_per_hour: 100,
    llm_source: null,
    cap_usd: null,
  },
  codes: [
    { id: 'c1', last4: 'MJHT', state: 'in_use', node_typeid: 'compute_node-1', created_at: '', last_used_at: null },
    { id: 'c2', last4: 'QQQQ', state: 'revoked', node_typeid: null, created_at: '', last_used_at: null },
  ],
  deployments: [
    {
      node_typeid: 'compute_node-1',
      name: 'box',
      status: 'PAUSED',
      code_id: 'c1',
      code_last4: 'MJHT',
      created_date: null,
      last_used_at: null,
    },
    {
      node_typeid: 'compute_node-2',
      name: 'box2',
      status: 'READY',
      code_id: null,
      code_last4: null,
      created_date: null,
      last_used_at: null,
    },
  ],
};

let urls: string[];
beforeEach(() => {
  urls = [];
  vi.spyOn(cloudManager, 'cloudAppUrl', 'get').mockReturnValue(HUB);
  vi.spyOn(dataManager, 'callAction').mockImplementation((info) => {
    urls.push(info.fullActionUrl);
    if (info.fullActionUrl.endsWith('/public_deployments')) return Promise.resolve(PAYLOAD);
    return Promise.resolve({ audience: 'visitor', roles: ['reader'] });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const tab = (version: AgentVersionState) => (
  <AgentAutoLaunchTab agent={new Agent({ id: AGENT_ID, name: 'q' })} version={version} />
);

describe('AgentAutoLaunchTab', () => {
  it('asks to publish first, and reads nothing, for an unpublished agent', () => {
    render(tab(UNPUBLISHED));
    expect(screen.getByTestId('agent-autolaunch-unpublished')).toHaveTextContent('Publish the agent first');
    expect(urls).toEqual([]);
  });

  it('shows the saved settings and every visitor box', async () => {
    render(tab(PUBLISHED));

    expect(await screen.findByTestId('agent-autolaunch-allow')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByTestId('agent-autolaunch-link')).toHaveTextContent(`${HUB}/open-pc/${AGENT_ID}`);
    expect(screen.getByTestId('agent-autolaunch-mode-code')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByTestId('agent-autolaunch-codes')).toHaveTextContent('Invite codes (1)');
    expect(screen.getByTestId('agent-autolaunch-max')).toHaveValue(3);
    // Saved and shown agree: nothing to update.
    expect(screen.queryByTestId('agent-autolaunch-update')).toBeNull();

    const rows = screen.getAllByTestId('agent-autolaunch-deployment');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('••••MJHT');
    expect(rows[0]).toHaveTextContent('Resume');
    expect(rows[1]).toHaveTextContent('link visitor');
    expect(rows[1]).toHaveTextContent('Pause');
  });
});
