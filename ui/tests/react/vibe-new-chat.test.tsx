import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkerModelTier } from '@sdk';

const startVibe = vi.fn();

vi.mock('@src/pages/flow-page/use-start-vibe-session', () => ({
  useStartVibeSession: () => startVibe,
}));

vi.mock('@sdk/react/hooks', () => ({
  useAuth: () => ({ user: { name: 'Ada Lovelace' } }),
}));

vi.mock('@src/components/open-project-component/open-project-component', () => ({
  OpenProjectComponent: () => null,
}));

import { VibeNewChat } from '@src/pages/flow-page/vibe-new-chat';

describe('VibeNewChat', () => {
  it('submits the selected portable model tier', async () => {
    const user = userEvent.setup();
    render(<VibeNewChat />);

    await user.click(screen.getByTestId('vibe-model-select'));
    await user.click(await screen.findByTestId('vibe-model-option-lg'));
    await user.type(screen.getByLabelText('What would you like to build?'), 'build a dashboard');
    await user.click(screen.getByTestId('session-input-submit'));

    expect(startVibe).toHaveBeenCalledWith('build a dashboard', undefined, WorkerModelTier.LG);
  });
});
