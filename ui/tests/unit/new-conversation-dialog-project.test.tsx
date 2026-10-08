import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ConversationParticipant } from '@sdk';
import { formatAutoTitle } from '@src/components/conversation/conversation-title';
import { NewConversationDialog } from '@src/components/new-conversation-dialog/NewConversationDialog';

// The dialog's collaborators are app plumbing; the seam is the send hook, whose
// target is exactly what the dialog decided to create.
const stable = vi.hoisted(() => ({
  nav: { navigation: { openDock: () => undefined } },
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
vi.mock('@src/hooks/use-send-to-conversation', () => ({
  useSendToConversation: () => stable.sender,
}));
vi.mock('@src/components/conversation/SendProgressNotice', () => ({ SendProgressNotice: () => null }));
vi.mock('@src/components/contact-picker/ContactPicker', () => ({
  ContactPicker: ({ onChange }: { onChange: (ps: ConversationParticipant[]) => void }) => (
    <button type="button" onClick={() => onChange([{ email: 'gadi@langware.ai', name: 'Gadi' }])}>
      add-participant
    </button>
  ),
}));

afterEach(() => {
  cleanup();
  stable.sender.send.mockReset();
});

describe('NewConversationDialog — the selected project', () => {
  it('ships the selected project when a participant is a hub user', async () => {
    stable.sender.send.mockResolvedValue('conversation-1');
    render(<NewConversationDialog open onClose={() => undefined} />);

    fireEvent.click(screen.getByText('add-participant'));
    fireEvent.change(screen.getByTestId('initial-message-input'), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(stable.sender.send).toHaveBeenCalledTimes(1));
    const [target] = stable.sender.send.mock.calls[0];
    expect(target.params.project_id).toBe('p-oss');
    expect(target.params.title).toMatch(/^\[flowpad-oss\] Me, Gadi - /);
  });
});

describe('formatAutoTitle', () => {
  const when = new Date(2026, 9, 7, 21, 42);

  it('prefixes the project name in brackets', () => {
    expect(formatAutoTitle([], 'Me', when, 'flowpad-oss')).toBe('[flowpad-oss] New conversation - Oct 7 21:42');
  });

  it('has no prefix without a project', () => {
    expect(formatAutoTitle([], 'Me', when)).toBe('New conversation - Oct 7 21:42');
  });
});
