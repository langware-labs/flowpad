/**
 * A place's Config shows only what it overrides; its Email tab moves the one
 * answering place.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, type AgentPlace } from '@sdk';

const nav = vi.hoisted(() => ({ openDock: vi.fn() }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: nav, currentDock: null }),
}));
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { AgentPlaceConfig } from '@src/components/assets/editor/agent-profile/AgentPlaceConfig';
import { AgentPlaceEmail } from '@src/components/assets/editor/agent-profile/AgentPlaceEmail';

const LOCAL_ID = '11111111-1111-4111-8111-111111111111';
const CLOUD_ID = '22222222-2222-4222-8222-222222222222';

function agent() {
  return new Agent({ id: '33333333-3333-4333-8333-333333333333', name: 'brief', model: 'haiku', enabled: true });
}

function place(id: string, isLocal: boolean, answers: boolean): AgentPlace {
  return {
    deployment: { id, name: isLocal ? 'local' : 'brief-1', kind: 'runtime.agent' },
    is_local: isLocal,
    overrides: {},
    schedule_count: 0,
    answers_email: answers,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('place config', () => {
  it('says the definition applies when nothing is overridden', () => {
    render(<AgentPlaceConfig agent={agent()} deploymentId={CLOUD_ID} overrides={{}} onChanged={vi.fn()} />);
    expect(screen.getByTestId('agent-place-no-overrides')).toBeInTheDocument();
  });

  it('shows an override beside the default it replaces, and Reset clears it', async () => {
    const a = agent();
    const set = vi.spyOn(a, 'setPlaceOverride').mockResolvedValue();
    const changed = vi.fn();
    render(<AgentPlaceConfig agent={a} deploymentId={CLOUD_ID} overrides={{ model: 'sonnet' }} onChanged={changed} />);

    const row = screen.getByTestId('agent-place-override-model');
    expect(row).toHaveTextContent('Model: sonnet');
    expect(row).toHaveTextContent('Default: haiku');
    fireEvent.click(screen.getByTestId('agent-place-reset-model'));
    await waitFor(() => expect(set).toHaveBeenCalledWith(CLOUD_ID, 'model', null));
    await waitFor(() => expect(changed).toHaveBeenCalled());
  });
});

describe('place email', () => {
  it('says who answers and moves the answer here', async () => {
    const a = agent();
    vi.spyOn(a, 'inboxState').mockResolvedValue({ agent_id: a.id, enabled: true, inbox: { address: 'brief@agents.flowpad.ai' }, source: null } as never);
    const move = vi.spyOn(a, 'setEmailPlace').mockResolvedValue();
    const changed = vi.fn();
    const local = place(LOCAL_ID, true, true);
    const cloud = place(CLOUD_ID, false, false);

    render(<AgentPlaceEmail agent={a} place={cloud} places={[local, cloud]} onChanged={changed} />);

    expect(await screen.findByTestId('agent-place-email-address')).toHaveTextContent('brief@agents.flowpad.ai');
    expect(screen.getByTestId('agent-place-email-elsewhere')).toHaveTextContent('Answered by this computer');
    fireEvent.click(screen.getByTestId('agent-place-email-move'));
    await waitFor(() => expect(move).toHaveBeenCalledWith(CLOUD_ID));
    await waitFor(() => expect(changed).toHaveBeenCalled());
  });

  it('marks the answering place', async () => {
    const a = agent();
    vi.spyOn(a, 'inboxState').mockRejectedValue(new Error('no login'));
    render(<AgentPlaceEmail agent={a} place={place(LOCAL_ID, true, true)} places={[place(LOCAL_ID, true, true)]} onChanged={vi.fn()} />);
    expect(await screen.findByTestId('agent-place-email-none')).toBeInTheDocument();
    expect(screen.getByTestId('agent-place-email-here')).toBeInTheDocument();
  });
});
