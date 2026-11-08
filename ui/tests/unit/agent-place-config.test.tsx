/**
 * A deployment's Config: every setting with the value in effect — its own override, else the agent's.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, Deployment } from '@sdk';

const nav = vi.hoisted(() => ({ openDock: vi.fn() }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: nav, currentDock: null }),
}));
vi.mock('@src/notifications', () => ({
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { AgentPlaceConfig } from '@src/components/assets/editor/agent-profile/AgentPlaceConfig';

const CLOUD_ID = '22222222-2222-4222-8222-222222222222';

function agent() {
  return new Agent({ id: '33333333-3333-4333-8333-333333333333', name: 'brief', model: 'haiku', enabled: true });
}

function deployment(overrides: Record<string, string> = {}) {
  return new Deployment({
    id: CLOUD_ID,
    name: 'cloud',
    target: { provider: 'e2b', scope: 'production' },
    main_agent_overrides: overrides,
  } as never);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('place config', () => {
  it('shows every setting with the agent\'s value when nothing is overridden', () => {
    render(<AgentPlaceConfig agent={agent()} deployment={deployment()} onChanged={vi.fn()} />);
    const model = screen.getByTestId('agent-place-inherited-model');
    expect(model).toHaveTextContent('Model: haiku');
    expect(model).toHaveTextContent('From the agent');
    for (const field of ['worker_type', 'permission_mode', 'effort', 'mcp_servers']) {
      expect(screen.getByTestId(`agent-place-inherited-${field}`)).toBeInTheDocument();
    }
  });

  it('Change sets an override for this deployment only', async () => {
    const a = agent();
    const d = deployment();
    const set = vi.spyOn(d, 'setMainAgentOverride').mockResolvedValue();
    render(<AgentPlaceConfig agent={a} deployment={d} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId('agent-place-add-override-model'));
    fireEvent.change(screen.getByTestId('agent-place-override-input'), { target: { value: 'sonnet' } });
    fireEvent.click(screen.getByTestId('agent-place-override-save'));
    await waitFor(() => expect(set).toHaveBeenCalledWith('model', 'sonnet'));
  });

  it('shows an override beside the default it replaces, and Reset clears it', async () => {
    const a = agent();
    const d = deployment({ model: 'sonnet' });
    const set = vi.spyOn(d, 'setMainAgentOverride').mockResolvedValue();
    const changed = vi.fn();
    render(<AgentPlaceConfig agent={a} deployment={d} onChanged={changed} />);

    const row = screen.getByTestId('agent-place-override-model');
    expect(row).toHaveTextContent('Model: sonnet');
    expect(row).toHaveTextContent("The agent's: haiku");
    fireEvent.click(screen.getByTestId('agent-place-reset-model'));
    await waitFor(() => expect(set).toHaveBeenCalledWith('model', null));
    await waitFor(() => expect(changed).toHaveBeenCalled());
  });
});
