/**
 * THE "Connect GitHub" button: starts the OAuth flow, spins while pending, and
 * hands the grant (or the failure) to the host's continuation — the share retry,
 * the sandbox clone, the repo list refresh.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  connect: vi.fn(() => Promise.resolve(undefined)),
  complete: null as null | ((msg: { status: string }) => void),
  enabled: false,
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, oauthService: { connect: h.connect } };
});
vi.mock('@sdk/react/hooks', () => ({
  useOAuthFlowComplete: (_p: string, handler: (msg: { status: string }) => void, enabled: boolean) => {
    h.complete = handler;
    h.enabled = enabled;
  },
}));

import { OAuthStatus } from '@sdk';
import { ConnectGithubButton } from '@src/components/git/ConnectGithubButton';

beforeEach(() => {
  vi.clearAllMocks();
  h.complete = null;
  h.enabled = false;
});
afterEach(cleanup);

describe('ConnectGithubButton', () => {
  it('starts the GitHub flow, waits, then runs the host continuation on success', async () => {
    const onConnected = vi.fn();
    render(<ConnectGithubButton onConnected={onConnected} testId="c" />);
    expect(h.enabled).toBe(false); // no listener until a connect is pending

    await userEvent.click(screen.getByTestId('c'));
    expect(h.connect).toHaveBeenCalledWith('github');
    expect(screen.getByTestId('c')).toBeDisabled();
    expect(h.enabled).toBe(true);

    act(() => h.complete?.({ status: OAuthStatus.SUCCESS }));
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('c')).not.toBeDisabled();
  });

  it('reports a flow that did not complete, and does not continue', async () => {
    const onConnected = vi.fn();
    const onError = vi.fn();
    render(<ConnectGithubButton onConnected={onConnected} onError={onError} testId="c" />);

    await userEvent.click(screen.getByTestId('c'));
    act(() => h.complete?.({ status: 'error' }));

    expect(onConnected).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("The GitHub connection didn't complete.");
  });

  it('reports a connect the backend refused, with its message', async () => {
    h.connect.mockRejectedValueOnce({ response: { data: { message: 'no client id' } } } as never);
    const onError = vi.fn();
    render(<ConnectGithubButton onError={onError} testId="c" />);

    await userEvent.click(screen.getByTestId('c'));

    expect(onError).toHaveBeenCalledWith('no client id');
    expect(screen.getByTestId('c')).not.toBeDisabled();
  });
});
