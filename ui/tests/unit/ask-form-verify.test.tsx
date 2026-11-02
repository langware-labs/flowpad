/**
 * A question that declares `verify` (a source setup step that judges the typed value) gets a Verify button
 * when its host says how to run it (`verifyWith`): pressing it hands the typed values to that step and shows
 * the step's own verdict in place; a paste runs it once by itself, after that only the button does.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@sdk/client', () => ({ default: { get: h.get, post: h.post } }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: {}, currentDock: null }),
}));

import { AskForm } from '@src/components/ask/AskForm';

/** The host's verify: the step name and the typed values, answered like a `ReturnedValue`. */
const verifyWith = vi.fn(async (_step: string, values: Record<string, string>) =>
  values.user_token === 'xoxp-good'
    ? { exit_code: 0, detail: 'Connected as @eran in Langware' }
    : { exit_code: 1, detail: 'Slack refused that token (invalid_auth).' },
);

const question = {
  id: 'q2',
  op: 'slack-ask-user-token',
  prompt: 'Paste the token',
  fields: { user_token: 'string' },
  secret: true,
  labels: { user_token: 'User OAuth Token (xoxp-…)' },
  verify: { label: 'Verify', source_step: 'app' },
};

beforeEach(() => {
  h.get.mockResolvedValue(question);
  h.post.mockResolvedValue({});
  verifyWith.mockClear();
});

afterEach(() => {
  cleanup();
  h.get.mockReset();
  h.post.mockReset();
});

it('verifies the typed value through the source step and shows its verdict', async () => {
  render(<AskForm questionId="q2" verifyWith={verifyWith} />);
  const input = await screen.findByTestId('ask-input-user_token');
  fireEvent.change(input, { target: { value: 'xoxp-good' } });
  fireEvent.click(screen.getByTestId('ask-verify-button'));
  const verdict = await screen.findByTestId('ask-verify-verdict');
  expect(verdict.textContent).toBe('Connected as @eran in Langware');
  expect(verdict.getAttribute('data-ok')).toBe('true');
  expect(verifyWith).toHaveBeenCalledWith('app', { user_token: 'xoxp-good' });
  // The question is still open: nothing was sent.
  expect(h.post.mock.calls.some(([path]) => String(path).endsWith('/answer'))).toBe(false);
});

it('says in words when the step refuses the value', async () => {
  render(<AskForm questionId="q2" verifyWith={verifyWith} />);
  const input = await screen.findByTestId('ask-input-user_token');
  fireEvent.change(input, { target: { value: 'xoxp-bad' } });
  fireEvent.click(screen.getByTestId('ask-verify-button'));
  const verdict = await screen.findByTestId('ask-verify-verdict');
  expect(verdict.textContent).toBe('Slack refused that token (invalid_auth).');
  expect(verdict.getAttribute('data-ok')).toBe('false');
});

it('runs once by itself after a paste, then only on the button', async () => {
  render(<AskForm questionId="q2" verifyWith={verifyWith} />);
  const input = await screen.findByTestId('ask-input-user_token');
  fireEvent.paste(input);
  fireEvent.change(input, { target: { value: 'xoxp-good' } });
  await waitFor(() => expect(verifyWith).toHaveBeenCalledTimes(1));
  expect((await screen.findByTestId('ask-verify-verdict')).getAttribute('data-ok')).toBe('true');
  fireEvent.paste(input);
  fireEvent.change(input, { target: { value: 'xoxp-bad' } });
  await new Promise((r) => setTimeout(r, 30));
  expect(verifyWith).toHaveBeenCalledTimes(1);
});

it('offers no Verify without a host to run it, or a question that declares none', async () => {
  render(<AskForm questionId="q2" />);
  await screen.findByTestId('ask-input-user_token');
  expect(screen.queryByTestId('ask-verify-button')).toBeNull();
  cleanup();
  h.get.mockResolvedValue({ ...question, verify: null });
  render(<AskForm questionId="q2" verifyWith={verifyWith} />);
  await screen.findByTestId('ask-input-user_token');
  expect(screen.queryByTestId('ask-verify-button')).toBeNull();
});
