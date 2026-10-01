import '@testing-library/jest-dom/vitest';

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Agent } from '@sdk';
import { AgentIntroCard } from '@src/components/agents/AgentIntroCard';

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() } }),
}));
vi.mock('@src/components/agents/AgentAvatar', () => ({
  AgentAvatar: () => <span data-testid="avatar" />,
}));

function agentWith(avatarImageUrl: string | null): Agent {
  const agent = new Agent({ name: 'scrooge' } as never);
  Object.defineProperty(agent, 'avatarImageUrl', { get: () => avatarImageUrl });
  return agent;
}

function openCard(agent: Agent) {
  render(
    <AgentIntroCard agent={agent}>
      <button>open</button>
    </AgentIntroCard>,
  );
  fireEvent.click(screen.getByText('open'));
}

describe('AgentIntroCard avatar', () => {
  it('opens the uploaded avatar full size in the media lightbox', () => {
    openCard(agentWith('/files/avatar.png'));
    fireEvent.click(screen.getByTestId('agent-intro-card-avatar'));
    const lightbox = screen.getByTestId('media-lightbox');
    expect(lightbox.querySelector('img')).toHaveAttribute('src', '/files/avatar.png');
    fireEvent.click(lightbox);
    expect(screen.queryByTestId('media-lightbox')).not.toBeInTheDocument();
  });

  it('leaves a glyph/initial avatar unclickable', () => {
    openCard(agentWith(null));
    expect(screen.getByTestId('avatar')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-intro-card-avatar')).not.toBeInTheDocument();
  });
});
