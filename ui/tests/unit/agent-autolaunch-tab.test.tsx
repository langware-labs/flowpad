/**
 * The agent's Auto-launch tab: it reads `public_deployments` from the hub and shows the saved settings,
 * the open link and each visitor's box; an unpublished agent is told to publish first.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    {
      id: 'c1',
      last4: 'MJHT',
      name: 'Noa',
      state: 'in_use',
      node_typeid: 'compute_node-1',
      created_at: '',
      last_used_at: null,
    },
    { id: 'c2', last4: 'QQQQ', state: 'revoked', node_typeid: null, created_at: '', last_used_at: null },
    { id: 'c3', last4: 'ZZZZ', name: '', state: 'unused', node_typeid: null, created_at: '', last_used_at: null },
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
      it_enabled: true,
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
let bodies: Record<string, unknown>[];
beforeEach(() => {
  urls = [];
  bodies = [];
  vi.spyOn(cloudManager, 'cloudAppUrl', 'get').mockReturnValue(HUB);
  vi.spyOn(dataManager, 'callAction').mockImplementation((info) => {
    urls.push(info.fullActionUrl);
    bodies.push((info.bodyParameters ?? {}) as Record<string, unknown>);
    if (info.fullActionUrl.endsWith('/public_deployments')) return Promise.resolve(PAYLOAD);
    if (info.fullActionUrl.endsWith('/it_sessions')) {
      const body = (info.bodyParameters ?? {}) as { targets: string[]; on: boolean };
      return Promise.resolve({ boxes: [{ node_typeid: body.targets[0], on: body.on }] });
    }
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
    // Settings read as one line, the mock's summary; the form opens on Edit settings.
    expect(screen.getByTestId('agent-invite-summary')).toHaveTextContent('Invite code only');
    expect(screen.getByTestId('agent-invite-summary')).toHaveTextContent('At most 3 at once');
    fireEvent.click(screen.getByTestId('agent-invite-edit-settings'));
    expect(screen.getByTestId('agent-autolaunch-mode-code')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByTestId('agent-autolaunch-codes')).toHaveTextContent('Add codes');
    // Revoked codes are gone; a used code and an unused one each get a line.
    expect(screen.getByTestId('agent-invite-count')).toHaveTextContent('Invites · 2 codes · 2 machines');
    expect(screen.getByTestId('agent-autolaunch-max')).toHaveValue(3);
    // Saved and shown agree: nothing to update.
    expect(screen.queryByTestId('agent-autolaunch-update')).toBeNull();

    const rows = screen.getAllByTestId('agent-autolaunch-deployment');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('••••MJHT');
    expect(rows[0]).toHaveTextContent('Resume');
    expect(rows[1]).toHaveTextContent('link visitor');
    expect(rows[1]).toHaveTextContent('Pause');
    // One line per invite: the used code carries its machine and its name; the unused one only Revoke.
    expect(screen.getAllByTestId('agent-invite-name')[0]).toHaveValue('Noa');
    const unused = screen.getByTestId('agent-invite-unused');
    expect(unused).toHaveTextContent('••••ZZZZ');
    expect(unused).toHaveTextContent('Revoke');
    expect(screen.queryByText('••••QQQQ')).toBeNull();
  });

  it('renames an invite on blur through rename_public_code', async () => {
    render(tab(PUBLISHED));
    const [name] = await screen.findAllByTestId('agent-invite-name');
    fireEvent.change(name, { target: { value: 'Amit' } });
    fireEvent.blur(name);
    await waitFor(() => expect(urls.some((u) => u.endsWith('/rename_public_code'))).toBe(true));
    expect(bodies[urls.findIndex((u) => u.endsWith('/rename_public_code'))]).toEqual({ code_id: 'c1', name: 'Amit' });
  });

  it('shows each machine IT Enabled / IT Disabled as the hub reports it, and one click flips it', async () => {
    render(tab(PUBLISHED));

    const rows = await screen.findAllByTestId('agent-autolaunch-deployment');
    expect(screen.getByTestId('it-message-send-open')).toHaveTextContent('Send IT message');
    const enabled = rows[0].querySelector('[data-testid="it-sessions-state"]') as HTMLElement;
    const unknown = rows[1].querySelector('[data-testid="it-sessions-state"]') as HTMLElement;
    expect(enabled).toHaveTextContent('IT Enabled'); // reported by the hub on first load
    expect(unknown).toHaveTextContent('IT —'); // the hub never saw it
    expect(enabled).toHaveAttribute('aria-label', expect.stringContaining('Click to disable'));
    expect(enabled).toHaveAttribute('data-it-enabled', 'true');
    expect(unknown).toHaveAttribute('data-it-enabled', 'unknown');

    fireEvent.click(enabled); // ONE click disables a machine that is enabled
    await waitFor(() => expect(enabled).toHaveTextContent('IT Disabled'));
    expect(enabled).toHaveAttribute('data-it-enabled', 'false');
    const at = urls.findIndex((u) => u.endsWith(`/agent/${AGENT_ID}/it_sessions`));
    expect(bodies[at]).toEqual({ targets: ['compute_node-1'], on: false });

    fireEvent.click(unknown); // unknown: a click enables it
    await waitFor(() => expect(unknown).toHaveTextContent('IT Enabled'));
    expect(bodies[urls.lastIndexOf(urls[at])]).toEqual({ targets: ['compute_node-2'], on: true });
  });
});
