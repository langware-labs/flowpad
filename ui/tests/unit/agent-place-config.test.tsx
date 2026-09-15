/**
 * A place's Config shows only what it overrides.
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
