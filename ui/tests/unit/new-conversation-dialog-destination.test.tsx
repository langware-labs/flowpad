import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NewConversationDialog } from '@src/components/new-conversation-dialog/NewConversationDialog';

// The same seams as new-conversation-dialog-project.test.tsx: app plumbing, and the send hook.
const stable = vi.hoisted(() => ({
  nav: { navigation: { openDock: () => undefined, openDockOnThisPage: vi.fn() } },
  ctx: { project: { id: 'p-oss' }, user: null },
  projects: { projects: [{ id: 'p-oss', displayName: 'flowpad-oss' }] },
  auth: { cloudUser: null, localUser: { name: 'Me' }, user: null },
  sender: { send: vi.fn(), busy: false, error: null, resetDraft: () => undefined },
}));
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => stable.nav }));
vi.mock('@src/hooks/useContext', () => ({ useContext: () => stable.ctx }));
vi.mock('@src/hooks/use-projects', () => ({ useProjects: () => stable.projects }));
vi.mock('@sdk/react/hooks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAuth: () => stable.auth,
}));
vi.mock('@src/hooks/use-send-to-conversation', () => ({ useSendToConversation: () => stable.sender }));
vi.mock('@src/components/conversation/SendProgressNotice', () => ({ SendProgressNotice: () => null }));

afterEach(() => {
  cleanup();
  stable.sender.send.mockReset();
});

describe('NewConversationDialog — a special destination', () => {
  it('shows the destination as the one participant and sends through it', async () => {
    const send = vi.fn().mockResolvedValue('conv-it-1');
    const onClose = vi.fn();
    render(
      <NewConversationDialog
        open
        onClose={onClose}
        destination={{
          label: 'IT · Game Builder deployments (5 machines)',
          note: '1 has IT Sessions off',
          title: 'IT · Game Builder - Nov 7',
          sendLabel: 'Send',
          send,
        }}
      />,
    );

    expect(screen.getByTestId('conversation-destination').textContent).toBe(
      'IT · Game Builder deployments (5 machines)',
    );
    expect(screen.getByText('1 has IT Sessions off')).toBeTruthy();
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Send' });
    expect(button.disabled).toBe(true); // nothing to send yet
    fireEvent.change(screen.getByTestId('initial-message-input'), { target: { value: 'Check progress' } });
    fireEvent.click(button);

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0]).toEqual({ title: 'IT · Game Builder - Nov 7', text: 'Check progress', files: [] });
    expect(stable.sender.send).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(stable.nav.navigation.openDockOnThisPage).toHaveBeenCalled();
  });
});
