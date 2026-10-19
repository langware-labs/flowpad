/**
 * A question's prompt keeps its lines: the label, then its hint and help link each on a line of their
 * own — never one run-on heading ("Gmail address https://…").
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@sdk/client', () => ({ default: { get: h.get, post: h.post } }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: {}, currentDock: null }),
}));

import { AskForm } from '@src/components/ask/AskForm';

beforeEach(() => {
  h.get.mockResolvedValue({
    id: 'q1',
    op: 'ask-gmail-GMAIL_APP_PASSWORD',
    prompt: 'App password\nhttps://myaccount.google.com/apppasswords',
    detail: 'Reads your Gmail mail into conversations.',
    fields: 'string',
  });
  h.post.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  h.get.mockReset();
});

it('renders the prompt with its newlines kept, and the why under it', async () => {
  render(<AskForm questionId="q1" />);
  const prompt = await screen.findByTestId('ask-prompt');
  expect(prompt).toHaveClass('whitespace-pre-line');
  expect(prompt.textContent).toBe('App password\nhttps://myaccount.google.com/apppasswords');
  expect(screen.getByTestId('ask-detail')).toHaveTextContent('Reads your Gmail mail into conversations.');
});
