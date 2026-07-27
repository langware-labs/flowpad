import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { DEFAULT_WORKER_TYPE } from '@src/components/workers/worker-types';
import { VIBE_MODEL_DEFAULT } from '@src/pages/flow-page/vibe-model-select';

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

// Not cosmetic: the `@sdk/react/hooks` factory above exposes only useAuth, so the
// real component's useChatHistory → useEntitiesQuery chain would throw on import.
vi.mock('@src/pages/flow-page/vibe-recent-sessions', () => ({
  VibeRecentSessions: () => null,
}));

import { VibeNewChat } from '@src/pages/flow-page/vibe-new-chat';

describe('VibeNewChat', () => {
  it('submits the default portable model tier and worker', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <VibeNewChat />
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText('What would you like to work on?'), 'build a dashboard');
    await user.click(screen.getByTestId('session-input-submit'));

    expect(startVibe).toHaveBeenCalledWith(
      'build a dashboard',
      undefined,
      VIBE_MODEL_DEFAULT,
      DEFAULT_WORKER_TYPE,
    );
  });
});
