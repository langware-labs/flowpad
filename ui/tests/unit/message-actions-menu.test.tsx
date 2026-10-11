/**
 * The message header row is name · time · receipt · ⋮ — every per-message action (reply, react,
 * forward, task it, download, note to the worker, favorite, edit name, delete) lives in the ⋮ menu.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

const toggleFavorite = vi.fn();
vi.mock('@sdk/react/hooks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useEntity: () => ({ data: null }),
}));
vi.mock('@src/components/view-mode', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useIsAdvanced: () => true,
}));
vi.mock('@src/hooks/use-favorites', () => ({ useFavorites: () => ({ isFavorited: () => null, toggleFavorite }) }));
vi.mock('@src/components/conversation/useLocalUser', () => ({ useLocalUser: () => ({ localUser: { id: 'me', name: 'Me' } }) }));
vi.mock('@src/components/conversation/EmojiPicker', async () => {
  // The real popover body (mounted only while open), with one emoji in it.
  const { PopoverContent } = await import('@src/components/ui/popover');
  return {
    EmojiPickerContent: ({ onPick }: { onPick: (e: string) => void }) => (
      <PopoverContent>
        <button type="button" data-testid="pick-thumbs" onClick={() => onPick('👍')}>
          pick
        </button>
      </PopoverContent>
    ),
  };
});

import { MessageBubble } from '@src/components/conversation/MessageBubble';
import { MessageActionsMenu } from '@src/components/conversation/MessageActionsMenu';

const openMenu = () => fireEvent.keyDown(screen.getByTestId('message-actions-menu'), { key: 'Enter' });

afterEach(cleanup);

describe('message header row', () => {
  it('shows only the sender, the time and the ⋮ — no action icons', () => {
    render(
      <MemoryRouter>
      <MessageBubble
        message={{ role: 'user', content: 'hello there', timestamp: '2026-10-04T14:47:00Z' } as never}
        flowMessageId="m-1"
        senderName="Ron Vardinon"
        onEditName={vi.fn()}
        onDeleteMessage={vi.fn()}
        onForwardMessage={vi.fn()}
        taskIt={{ onClick: vi.fn() }}
        onReply={vi.fn()}
        onReact={vi.fn()}
      />
      </MemoryRouter>,
    );
    const row = screen.getByText('Ron Vardinon').parentElement!;
    expect(within(row).getAllByRole('button').map((b) => b.getAttribute('data-testid'))).toEqual(['message-actions-menu']);
    for (const id of ['message-reply', 'message-react', 'message-forward', 'message-task-it', 'message-download']) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    expect(screen.queryByTitle('Delete message')).toBeNull();
    expect(screen.queryByTitle('Edit name')).toBeNull();
  });
});

describe('message ⋮ menu', () => {
  it('holds every action and fires each one', () => {
    const onReply = vi.fn();
    const onForward = vi.fn();
    const onTaskIt = vi.fn();
    const onDelete = vi.fn();
    render(
      <MessageActionsMenu
        flowMessageId="m-1"
        conversationId="22222222-2222-4222-8222-222222222222"
        messageText="please add the founding number"
        onReply={onReply}
        replyInThread
        onReact={vi.fn()}
        onForward={onForward}
        onTaskIt={onTaskIt}
        onEditName={vi.fn()}
        onDelete={onDelete}
      />,
    );
    openMenu();
    expect(screen.getByTestId('message-reply').textContent).toContain('Reply in thread');
    for (const id of ['message-react', 'message-forward', 'message-task-it', 'message-download', 'message-favorite', 'message-edit-name', 'message-delete']) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    fireEvent.click(screen.getByTestId('message-reply'));
    expect(onReply).toHaveBeenCalled();
    openMenu();
    fireEvent.click(screen.getByTestId('message-favorite'));
    expect(toggleFavorite).toHaveBeenCalledWith({
      entityType: 'flow_message',
      entityId: 'm-1',
      title: 'please add the founding number',
      nav: { parent_type_id: 'conversation-22222222-2222-4222-8222-222222222222' },
    });
    openMenu();
    fireEvent.click(screen.getByTestId('message-delete'));
    expect(onDelete).toHaveBeenCalled();
  });

  it('React opens the picker after the menu closes and hands the emoji up', () => {
    const onReact = vi.fn();
    render(<MessageActionsMenu flowMessageId="m-1" onReact={onReact} />);
    openMenu();
    fireEvent.click(screen.getByTestId('message-react'));
    fireEvent.click(screen.getByTestId('pick-thumbs'));
    expect(onReact).toHaveBeenCalledWith('👍');
  });

  it("shows the header's worker icon bar and hands the picked worker up, closing the menu", () => {
    const onLaunchWorker = vi.fn();
    render(
      <MemoryRouter>
        <MessageActionsMenu flowMessageId="m-1" conversationId="c-1" onLaunchWorker={onLaunchWorker} />
      </MemoryRouter>,
    );
    openMenu();
    const [first] = within(screen.getByTestId('message-launch-toolbar')).getAllByRole('button');
    fireEvent.click(first);
    expect(onLaunchWorker).toHaveBeenCalledWith(first.getAttribute('data-testid')!.replace('message-launch-', ''));
    expect(screen.queryByTestId('message-launch-toolbar')).toBeNull();
  });

  it('no worker bar without a launcher (drafts)', () => {
    render(<MessageActionsMenu flowMessageId="m-1" conversationId="c-1" />);
    openMenu();
    expect(screen.queryByTestId('message-launch-toolbar')).toBeNull();
  });

  it('a channel or forwarded message says so at the top of the menu', () => {
    render(<MessageActionsMenu flowMessageId="m-1" forwarded />);
    openMenu();
    expect(screen.getByTestId('message-forwarded-marker')).toBeTruthy();
  });
});
