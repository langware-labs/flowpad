/**
 * The ask modal — what closing it WITHOUT a button means.
 *
 * An `until_answered` ask has no deadline. A dialog that Esc (or a click
 * outside) simply hid left its question open on the backend with nothing on
 * screen to answer it, and the wizard that raised it — and its run slot — held
 * until the backend restarted. Dismissing is the person's "no": it cancels.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock('@sdk/client', () => ({ default: { get: h.get, post: h.post } }));
vi.mock('@sdk/react/hooks', () => ({ useEntity: () => ({ data: null }) }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() }, currentDock: null }),
}));

import { AskModalRoot } from '@src/components/ask/AskModal';
import { openAskModal, useAskModalStore } from '@src/components/ask/ask-modal-store';

const QUESTION = {
  id: 'q-1',
  op: 'ask-install-jq',
  prompt: 'jq is required to continue',
  fields: 'confirm',
  submit_label: 'Install',
  cancel_label: 'Skip',
};

describe('AskModal dismissal', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    h.get.mockResolvedValue(QUESTION);
    h.post.mockResolvedValue({});
    act(() => useAskModalStore.setState({ open: false, payload: null }));
  });

  it('Esc cancels the open question, then closes', async () => {
    render(<AskModalRoot />);
    act(() => openAskModal('q-1'));
    await screen.findByTestId('ask-modal-prompt');

    fireEvent.keyDown(screen.getByTestId('ask-modal'), { key: 'Escape' });

    await waitFor(() => expect(h.post).toHaveBeenCalledWith('/api/v1/ask/q-1/cancel', undefined));
    await waitFor(() => expect(screen.queryByTestId('ask-modal')).toBeNull());
  });

  it('a question already gone closes without cancelling anything', async () => {
    h.get.mockRejectedValue(new Error('404'));
    render(<AskModalRoot />);
    act(() => openAskModal('q-1'));

    await waitFor(() => expect(screen.queryByTestId('ask-modal')).toBeNull());
    expect(h.post).not.toHaveBeenCalled();
  });
});
