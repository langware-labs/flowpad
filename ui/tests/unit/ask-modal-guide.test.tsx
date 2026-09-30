/**
 * The ask modal's "guide" box — `setup.md`, shown beside the question.
 *
 * Genuinely helpful beside a FIELD asking for a value ("copy the Phone number
 * ID") — that is what it was written for (`test_a_question_names_the_run_that_
 * asked_and_carries_the_ops_guide`, the backend side of this same feature). A
 * plain yes/no confirm has no field to guide anyone through, and its own
 * `setup.md` is written for the next maintainer reading the asset, not for
 * whoever is pressing Install/Skip — showing it there is pure noise, and was
 * never the point.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock('@sdk/client', () => ({ default: { get: h.get, post: h.post } }));
vi.mock('@sdk/react/hooks', () => ({ useEntity: () => ({ data: null }) }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() }, currentDock: null }),
}));

import { AskModalRoot } from '@src/components/ask/AskModal';
import { openAskModal, useAskModalStore } from '@src/components/ask/ask-modal-store';

const CONFIRM = {
  id: 'q-1',
  op: 'ask-install-claude-code',
  prompt: 'Claude Code is required to continue',
  detail: "It doesn't appear to be installed on your computer. Would you like to install it now?",
  // `ConfirmSpec` has no fields — this is what the real backend sends for it
  // (`fields_of_kind("confirm")`), not the bare string a coarser fixture might use.
  fields: {},
  guide: 'Asks before installing Claude Code. Send means yes; Cancel means leave it uninstalled.',
  submit_label: 'Install',
  cancel_label: 'Skip',
};

const NEEDS_A_VALUE = {
  id: 'q-2',
  op: 'whatsapp-ask-phone-number-id',
  prompt: 'WhatsApp phone number ID',
  fields: { value: 'string' },
  guide: 'Open WhatsApp → API Setup and copy the **Phone number ID**.',
  submit_label: 'Send',
  cancel_label: 'Cancel',
};

beforeEach(() => {
  vi.clearAllMocks();
  useAskModalStore.setState({ open: false, payload: null });
});
afterEach(cleanup);

describe('AskModal guide box', () => {
  it('stays hidden beside a plain confirm — nothing there to guide anyone through', async () => {
    h.get.mockResolvedValue(CONFIRM);
    render(<AskModalRoot />);
    openAskModal('q-1');

    await screen.findByTestId('ask-modal-prompt');
    expect(screen.queryByTestId('ask-modal-guide')).toBeNull();
  });

  it('shows beside a question that actually asks for a value', async () => {
    h.get.mockResolvedValue(NEEDS_A_VALUE);
    render(<AskModalRoot />);
    openAskModal('q-2');

    await waitFor(() => expect(screen.getByTestId('ask-modal-guide')).toBeTruthy());
    expect(screen.getByTestId('ask-modal-guide').textContent).toContain('Phone number ID');
  });

  it('sits above the other dialogs, so the wizard popup that raised it cannot cover it', async () => {
    h.get.mockResolvedValue(CONFIRM);
    render(<AskModalRoot />);
    openAskModal('q-1');

    await screen.findByTestId('ask-modal-prompt');
    expect(screen.getByTestId('ask-modal').className).toContain('z-[60]');
  });
});
