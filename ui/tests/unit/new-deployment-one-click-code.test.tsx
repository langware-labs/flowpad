/**
 * New deployment with invites already on: the code tile is one click to a new code, shown on the same card with
 * Copy, Open machine (the student page with the code in its fragment) and an optional name saved on Done.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/components/llm-sources/use-llm-sources', () => ({
  useLlmSources: () => ({ status: { available: [] }, isLoading: false }),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => ({ navigation: {} }) }));
vi.mock('@src/components/assets/editor/agent-profile/AgentVisibilitySection', () => ({
  useVisitorRole: () => ['runner', () => undefined],
}));

const { Agent, cloudManager, dataManager } = await import('@sdk');
const { NewDeploymentWizard } = await import('@src/components/assets/editor/agent-profile/NewDeploymentWizard');

const AGENT_ID = '11111111-2222-4333-8444-555555555555';
const HUB = 'https://app.flowpad.ai';
const STATE = {
  settings: { allow_visitor_deployment: true, mode: 'code', max_deployments: 8, llm_source: null, cap_usd: 5 },
  codes: [],
  deployments: [],
};

let calls: { url: string; body: Record<string, unknown> }[];
beforeEach(() => {
  calls = [];
  vi.spyOn(cloudManager, 'cloudAppUrl', 'get').mockReturnValue(HUB);
  vi.spyOn(dataManager, 'callAction').mockImplementation((info) => {
    calls.push({ url: info.fullActionUrl, body: (info.bodyParameters ?? {}) as Record<string, unknown> });
    if (info.fullActionUrl.endsWith('/add_public_codes'))
      return Promise.resolve({ codes: [{ id: 'n1', code: 'ABCD-EFGH', last4: 'EFGH', name: '' }] });
    if (info.fullActionUrl.endsWith('/public_deployments')) return Promise.resolve(STATE);
    return Promise.resolve({});
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const wizard = (onOpenInvite = () => undefined) => (
  <NewDeploymentWizard
    agent={new Agent({ id: AGENT_ID, name: 'game-builder' })}
    onClose={() => undefined}
    onOpenInvite={onOpenInvite}
  />
);

describe('NewDeploymentWizard — one-click invite code', () => {
  it('mints one code in one click and shows it with Copy and Open machine', async () => {
    render(wizard());
    const tile = await screen.findByTestId('new-deployment-kind-code');
    await waitFor(() => expect(tile).toHaveTextContent('Get an invite code'));
    fireEvent.click(tile);

    expect(await screen.findByTestId('one-click-code-value')).toHaveTextContent('ABCD-EFGH');
    expect(calls.find((c) => c.url.endsWith('/add_public_codes'))?.body).toEqual({ count: 1 });
    expect(screen.getByTestId('one-click-copy')).toBeInTheDocument();
    expect(screen.getByText(/8 of 8 machines left/)).toBeInTheDocument();

    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    fireEvent.click(screen.getByTestId('one-click-open-machine'));
    expect(open).toHaveBeenCalledWith(`${HUB}/open-pc/${AGENT_ID}#code=ABCD-EFGH`, '_blank', 'noopener');
  });

  it('saves the typed name on Done and opens the invite deployment', async () => {
    const onOpenInvite = vi.fn();
    render(wizard(onOpenInvite));
    const tile = await screen.findByTestId('new-deployment-kind-code');
    await waitFor(() => expect(tile).toHaveTextContent('Get an invite code'));
    fireEvent.click(tile);
    fireEvent.change(await screen.findByTestId('one-click-name'), { target: { value: 'Noa' } });
    fireEvent.click(screen.getByTestId('one-click-done'));

    await waitFor(() => expect(onOpenInvite).toHaveBeenCalled());
    expect(calls.find((c) => c.url.endsWith('/rename_public_code'))?.body).toEqual({ code_id: 'n1', name: 'Noa' });
  });
});
