import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { VIBE_MODEL_DEFAULT } from '@src/pages/flow-page/vibe-model-select';

const startVibe = vi.fn();

vi.mock('@src/pages/flow-page/use-start-vibe-session', () => ({
  useStartVibeSession: () => startVibe,
}));

// Stable identity, like the real hook — a fresh object per render would
// re-fire any consumer memo/effect keyed on it.
const EMPTY_ENTITIES_QUERY = {
  data: [] as never[],
  isLoading: false,
  error: null,
  isError: false,
  isSuccess: true,
  refetch: () => {},
};

vi.mock('@sdk/react/hooks', () => ({
  useAuth: () => ({ user: { name: 'Ada Lovelace' } }),
  // ProjectActionsRow (rendered by VibeNewChat) reads `useProjects()`, which is
  // built on `useEntitiesQuery`. This surface only branches on whether the list
  // is non-empty, and the assertions below are about the submitted model tier —
  // so an empty, settled result keeps the row in its no-projects state without
  // pulling a live query into this render.
  useEntitiesQuery: () => EMPTY_ENTITIES_QUERY,
  // ProjectAgentsStrip (rendered by VibeNewChat) resolves the active project
  // via `useProject()`; no project keeps the strip empty, which is fine — the
  // assertions below are about the submitted model tier.
  useProject: () => ({ project: null }),
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
  it('submits the portable model tier and leaves worker resolution to the backend', async () => {
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
    );
  });
});
