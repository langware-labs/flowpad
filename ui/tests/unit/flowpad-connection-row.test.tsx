/**
 * The FlowPad row in the Connections table.
 *
 * It exists because FlowPad's own account was the one connection you could not
 * see or manage from the Connections screen — the app signed you in somewhere
 * else entirely. The pin that matters is that this row does NOT go through the
 * OAuth machinery: `flowpad_cloud` is not a registered provider, so a row driven
 * by `grantStatuses` would read "Not connected" no matter who is logged in, and
 * a Connect routed through `useOAuthConnection` would never clear its spinner
 * (no flow is registered, so `OAUTH_FLOW_COMPLETE` never fires).
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  login: { status: 'logged_out', user: null, reason: null } as Record<string, unknown>,
  connection: { status: 'disconnected', error: null } as Record<string, unknown>,
  cloudLogin: vi.fn(async () => undefined),
  generate: vi.fn(),
}));

vi.mock('@sdk/react/hooks', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useCloudStatus: () => ({
    login: h.login,
    connection: h.connection,
    cloudUrl: 'https://flowpad.ai',
    connectionControlsAvailable: true,
  }),
}));
vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  cloudManager: { login: h.cloudLogin },
}));
vi.mock('@src/components/api-keys-view/use-user-api-keys', () => ({
  useUserApiKeys: () => ({
    apiKeys: [],
    flowpadKey: null,
    generatedKey: null,
    generate: h.generate,
    remove: vi.fn(),
    isLoading: false,
  }),
}));

const { FlowpadConnectionRow } = await import(
  '@src/components/connections-manager/flowpad-connection-row'
);

/** The row renders `<tr>`s, so it needs a table around it to be valid DOM. */
const renderRow = () =>
  render(
    <table>
      <tbody>
        <FlowpadConnectionRow />
      </tbody>
    </table>,
  );

describe('FlowpadConnectionRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.login = { status: 'logged_out', user: null, reason: null };
    h.connection = { status: 'disconnected', error: null };
  });
  afterEach(() => cleanup());

  it('offers Connect when signed out', () => {
    renderRow();
    // The wording is the SHARED hub-status table's, so this row and the Account
    // screen cannot drift apart on the same fact.
    expect(screen.getByTestId('connection-status-flowpad').textContent).toMatch(/logged out/i);
    expect(screen.getByTestId('connection-flowpad-connect')).toBeTruthy();
  });

  it('signs in through cloudManager, not the OAuth service', async () => {
    renderRow();
    await userEvent.click(screen.getByTestId('connection-flowpad-connect'));
    expect(h.cloudLogin).toHaveBeenCalledTimes(1);
  });

  it('clears its own busy state when the login settles', async () => {
    // The reason this row owns its busy state: routed through
    // `useOAuthConnection`, nothing would ever clear it.
    let release: (() => void) | undefined;
    h.cloudLogin.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (release = () => resolve(undefined))),
    );
    renderRow();

    await userEvent.click(screen.getByTestId('connection-flowpad-connect'));
    expect((screen.getByTestId('connection-flowpad-connect') as HTMLButtonElement).disabled).toBe(true);

    release?.();
    await waitFor(() =>
      expect((screen.getByTestId('connection-flowpad-connect') as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });

  it('reports connected from the hub slots, with no OAuth grant anywhere', () => {
    // There is no `grantStatuses` entry for flowpad_cloud and there never will
    // be. If this row ever starts consulting it, this test goes red.
    h.login = { status: 'logged_in', user: { email: 'me@example.com' }, reason: null };
    h.connection = { status: 'verified', error: null };
    renderRow();

    expect(screen.getByTestId('connection-status-flowpad').textContent).toMatch(
      /connection verified/i,
    );
    expect(screen.queryByTestId('connection-flowpad-connect')).toBeNull();
  });

  it('keeps the API key with the account it belongs to', async () => {
    renderRow();
    expect(screen.queryByTestId('connection-flowpad-key-panel')).toBeNull();

    await userEvent.click(screen.getByTestId('connection-flowpad-key'));
    expect(screen.getByTestId('connection-flowpad-key-panel')).toBeTruthy();
  });
});
