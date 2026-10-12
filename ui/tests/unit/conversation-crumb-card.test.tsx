/** A conversation crumb opens a card saying which conversation it is. */
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Conversation } from '@sdk';
import { ConversationCrumbHoverCard } from '@src/components/top-nav-bar/ConversationCrumbHoverCard';

vi.mock('@src/components/ui/hover-card', () => ({
  HoverCard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  HoverCardTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  HoverCardContent: ({ children, ...rest }: { children: React.ReactNode }) => <div {...rest}>{children}</div>,
}));
vi.mock('@src/hooks/entity-hooks', () => ({
  useEntity: () => ({
    data: new Conversation({
      title: 'New BUGS',
      channel: 'whatsapp',
      message_count: 12,
      address: ['+972500000000'],
    } as never),
  }),
}));

afterEach(cleanup);

describe('ConversationCrumbHoverCard', () => {
  it('shows the title, channel, message count and who it is with', () => {
    render(
      <ConversationCrumbHoverCard conversationId="3f2b8c1e-6a4d-4e2b-9c1a-5d7e8f901234">
        <button>crumb</button>
      </ConversationCrumbHoverCard>,
    );
    const card = screen.getByTestId('top-nav-conversation-details');
    expect(card).toHaveTextContent('New BUGS');
    expect(card).toHaveTextContent('Whatsapp');
    expect(card).toHaveTextContent('12');
    expect(card).toHaveTextContent('+972500000000');
  });
});
