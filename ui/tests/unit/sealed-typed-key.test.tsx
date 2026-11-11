import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { credentialsService } from '@sdk';
import { SealedTypedCard } from '@src/components/conversation/SealedTypedCard';
import { SecureSendDialog } from '@src/components/conversation/SecureSendDialog';

vi.mock('@src/hooks/use-projects', () => ({
  useProjects: () => ({ projects: [{ id: 'p-demo', title: 'Demo' }, { id: 'p-other', title: 'Other' }] }),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => ({ navigation: { openDock: vi.fn() } }) }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CARD = { message_id: 'm-1', transfer_id: 't-1', sender_name: 'Dana', expires_at: '', state: 'pending', credential_name: 'OPENAI_API_KEY', typed: true };

describe('Secured transfer of a typed key', () => {
  it('the sender types a name and a key and sends them', async () => {
    const send = vi.spyOn(credentialsService, 'sealedSend').mockResolvedValue({ sealed_for: ['u-bob'], no_key: [] });
    const onClose = vi.fn();
    render(<SecureSendDialog conversationId="c-1" onClose={onClose} onPickSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('secure-send-name'), { target: { value: 'openai-api-key' } });
    fireEvent.change(screen.getByTestId('secure-send-value'), { target: { value: 'sk-1' } });
    fireEvent.click(screen.getByTestId('secure-send-submit'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(send).toHaveBeenCalledWith('c-1', 'OPENAI_API_KEY', 'sk-1');
  });

  it('the receiver saves it to the conversation project; a name already set asks Replace', async () => {
    const save = vi
      .spyOn(credentialsService, 'sealedFill')
      .mockRejectedValueOnce({ response: { data: { data: { error_code: 'exists' } } } })
      .mockResolvedValueOnce({ filled: ['OPENAI_API_KEY'], credential: 'credential-x' });
    const onDone = vi.fn();
    render(<SealedTypedCard card={CARD} conversationId="c-1" projectId="p-demo" onDone={onDone} onDecline={vi.fn()} />);
    expect((screen.getByTestId('sealed-place') as HTMLSelectElement).value).toBe('p-demo');
    fireEvent.click(screen.getByTestId('sealed-accept'));
    await screen.findByTestId('sealed-clash');
    fireEvent.click(screen.getByTestId('sealed-replace'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(save.mock.calls).toEqual([['c-1', 'm-1', { place: 'p-demo', replace: false }], ['c-1', 'm-1', { place: 'p-demo', replace: true }]]);
  });
});
