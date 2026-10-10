/**
 * The automation chip on a message and the quick door beside the star (docs/snippets/stream-inbox-automations.md).
 *
 * The chip is ⚡ + who, a link to the session an automation started; the quick ⚡ in the header starts a
 * rule on messages like this one. Both are plain callbacks here — the real bubble, the real header row.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

vi.mock('@src/hooks/use-favorites', () => ({ useFavorites: () => ({ isFavorited: () => null, toggleFavorite: vi.fn() }) }));
vi.mock('@src/components/conversation/useLocalUser', () => ({ useLocalUser: () => ({ localUser: { id: 'me', name: 'Me' } }) }));

import { MessageBubble } from '@src/components/conversation/MessageBubble';

afterEach(cleanup);

const message = { role: 'user', content: 'I see two charges of $49 on my card.', timestamp: '2026-10-10T10:41:00Z' } as never;

describe('an automation on a message', () => {
  it('shows ⚡ + the agent as a chip that opens the session', () => {
    const onOpen = vi.fn();
    render(
      <MemoryRouter>
        <MessageBubble
          message={message}
          flowMessageId="m-1"
          senderName="Dana Levi"
          automation={{ name: 'Billing helper', status: 'running', onOpen }}
        />
      </MemoryRouter>,
    );
    const chip = screen.getByTestId('message-automation-chip');
    expect(chip.textContent).toContain('Billing helper');
    expect(chip.getAttribute('data-status')).toBe('running');
    fireEvent.click(chip);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('a session that never finished reads as a dashed chip', () => {
    render(
      <MemoryRouter>
        <MessageBubble message={message} flowMessageId="m-1" senderName="Dana" automation={{ name: 'Trip planner', status: 'failed', onOpen: vi.fn() }} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('message-automation-chip').className).toContain('border-dashed');
  });

  it('the quick ⚡ sits in the header row and starts a rule; without it the row is unchanged', () => {
    const onAutomate = vi.fn();
    render(
      <MemoryRouter>
        <MessageBubble message={message} flowMessageId="m-1" senderName="Dana Levi" onAutomate={onAutomate} />
      </MemoryRouter>,
    );
    const row = screen.getByText('Dana Levi').parentElement!;
    const quick = within(row).getByTestId('message-automate-quick-m-1');
    fireEvent.click(quick);
    expect(onAutomate).toHaveBeenCalledTimes(1);
    cleanup();
    render(
      <MemoryRouter>
        <MessageBubble message={message} flowMessageId="m-1" senderName="Dana Levi" />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('message-automate-quick-m-1')).toBeNull();
    expect(screen.queryByTestId('message-automation-chip')).toBeNull();
  });
});
