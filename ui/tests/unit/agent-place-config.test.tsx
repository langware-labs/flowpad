/**
 * A deployment's Config: every setting with the value in effect — its own override, else the agent's.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '@sdk';

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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('place config', () => {
  it('shows every setting with the agent\'s value when nothing is overridden', () => {
    render(<AgentPlaceConfig agent={agent()} deploymentId={CLOUD_ID} overrides={{}} onChanged={vi.fn()} />);
    const model = screen.getByTestId('agent-place-inherited-model');
    expect(model).toHaveTextContent('Model: haiku');
    expect(model).toHaveTextContent('From the agent');
    for (const field of ['worker_type', 'permission_mode', 'effort', 'mcp_servers']) {
      expect(screen.getByTestId(`agent-place-inherited-${field}`)).toBeInTheDocument();
    }
  });

  it('Change sets an override for this deployment only', async () => {
    const a = agent();
    const set = vi.spyOn(a, 'setPlaceOverride').mockResolvedValue();
    render(<AgentPlaceConfig agent={a} deploymentId={CLOUD_ID} overrides={{}} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId('agent-place-add-override-model'));
    fireEvent.change(screen.getByTestId('agent-place-override-input'), { target: { value: 'sonnet' } });
    fireEvent.click(screen.getByTestId('agent-place-override-save'));
    await waitFor(() => expect(set).toHaveBeenCalledWith(CLOUD_ID, 'model', 'sonnet'));
  });

  it('shows an override beside the default it replaces, and Reset clears it', async () => {
    const a = agent();
    const set = vi.spyOn(a, 'setPlaceOverride').mockResolvedValue();
    const changed = vi.fn();
    render(<AgentPlaceConfig agent={a} deploymentId={CLOUD_ID} overrides={{ model: 'sonnet' }} onChanged={changed} />);

    const row = screen.getByTestId('agent-place-override-model');
    expect(row).toHaveTextContent('Model: sonnet');
    expect(row).toHaveTextContent("The agent's: haiku");
    fireEvent.click(screen.getByTestId('agent-place-reset-model'));
    await waitFor(() => expect(set).toHaveBeenCalledWith(CLOUD_ID, 'model', null));
    await waitFor(() => expect(changed).toHaveBeenCalled());
  });
});
