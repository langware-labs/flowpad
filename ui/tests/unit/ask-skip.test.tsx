/**
 * A setup question's own Skip (`skippable`): the step is skipped the way its setup-list row skips it, and setup
 * goes on. A question no setup asked has none — Cancel is its only way out.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock('@sdk/client', () => ({ default: { get: h.get, post: h.post } }));
vi.mock('@sdk/react/hooks', () => ({ useEntity: () => ({ data: null }) }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() }, currentDock: null }),
}));

import { AskModalRoot } from '@src/components/ask/AskModal';
import { AskForm } from '@src/components/ask/AskForm';
import { openAskModal, useAskModalStore } from '@src/components/ask/ask-modal-store';

const GMAIL = {
  id: 'q-1',
  op: 'gmail',
  prompt: 'Gmail',
  fields: { value: 'string' },
  run: 'setup-micro_app-x',
  skippable: true,
  choices: [{ name: 'google', label: 'Sign in with Google', fields: [] }],
};

beforeEach(() => {
  vi.clearAllMocks();
  useAskModalStore.setState({ open: false, payload: null });
  h.post.mockResolvedValue({});
});
afterEach(cleanup);

describe('a setup question', () => {
  it('in the popup, Skip skips the step asking', async () => {
    h.get.mockResolvedValue(GMAIL);
    render(<AskModalRoot />);
    openAskModal('q-1');
    fireEvent.click(await screen.findByTestId('ask-skip'));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith('/api/v1/ask/q-1/skip', undefined));
  });

  it('drawn in place, Skip skips it and the screen hears it settled', async () => {
    h.get.mockResolvedValue(GMAIL);
    const onSettled = vi.fn();
    render(<AskForm questionId="q-1" onSettled={onSettled} />);
    fireEvent.click(await screen.findByTestId('ask-skip'));
    await waitFor(() => expect(onSettled).toHaveBeenCalledWith('answered'));
    expect(h.post).toHaveBeenCalledWith('/api/v1/ask/q-1/skip', undefined);
  });

  it('a question no setup asked offers no Skip', async () => {
    h.get.mockResolvedValue({ ...GMAIL, skippable: false });
    render(<AskForm questionId="q-1" />);
    await screen.findByTestId('ask-cancel');
    expect(screen.queryByTestId('ask-skip')).toBeNull();
  });
});
