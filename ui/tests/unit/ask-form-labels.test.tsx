/**
 * A record question names its fields for a person (`labels`: "User OAuth Token", not `user_token`), and a
 * question that is one of a sequence says where it stands ("2 of 2 · Paste the token") above its prompt.
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
    id: 'q2',
    op: 'slack-ask-app-keys',
    prompt: 'Paste the token',
    fields: { user_token: 'string', signing_secret: 'string' },
    secret: true,
    labels: { user_token: 'User OAuth Token (xoxp-…)', signing_secret: 'Signing Secret' },
    stage: { label: 'Paste the token', index: 2, total: 2 },
  });
  h.post.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  h.get.mockReset();
  h.post.mockReset();
});

it('labels each field for a person, keeping the key for the input', async () => {
  render(<AskForm questionId="q2" />);
  expect((await screen.findByTestId('ask-label-user_token')).textContent).toBe('User OAuth Token (xoxp-…)');
  expect(screen.getByTestId('ask-label-signing_secret').textContent).toBe('Signing Secret');
  expect(screen.getByTestId('ask-input-user_token')).toBeInTheDocument();
});

it('says where the question stands in its sequence, above the prompt, without repeating it', async () => {
  render(<AskForm questionId="q2" />);
  expect((await screen.findByTestId('ask-stage')).textContent).toBe('2 of 2');
  cleanup();
  h.get.mockResolvedValue({ id: 'q4', op: 'x', prompt: 'Paste the token', fields: 'string', stage: { label: 'Set up on Slack', index: 2, total: 2 } });
  render(<AskForm questionId="q4" />);
  expect((await screen.findByTestId('ask-stage')).textContent).toBe('2 of 2 · Set up on Slack');
});

it('shows no stage line when the question stands alone', async () => {
  h.get.mockResolvedValue({ id: 'q3', op: 'x', prompt: 'One thing', fields: 'string' });
  render(<AskForm questionId="q3" />);
  await screen.findByTestId('ask-prompt');
  expect(screen.queryByTestId('ask-stage')).toBeNull();
});
