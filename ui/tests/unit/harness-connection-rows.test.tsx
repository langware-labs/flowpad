/**
 * Harness device logins in the Connections table.
 *
 * The row is a pure presenter: the backend composes the verdict and this draws
 * it, and the host owns navigation. So this file needs neither a router nor a
 * funding fixture — it feeds the component the same `ConnectionSpec` the one
 * consolidated read hands over.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConnectionKind, ConnectionState, type ConnectionSpec } from '@sdk';
import { HarnessConnectionRows } from '@src/components/connections-manager/harness-connection-rows';

function spec(over: Partial<ConnectionSpec> = {}): ConnectionSpec {
  return {
    provider: 'claude',
    display_name: 'Claude',
    kind: ConnectionKind.Harness,
    state: ConnectionState.Unknown,
    connected: false,
    detail: '',
    identity: '',
    account: '',
    icon: '',
    scope: 'machine',
    credential_ref: '',
    scopes: [],
    env_vars: [],
    ...over,
  };
}

const renderRows = (rows: ConnectionSpec[], onDetails?: (worker: string) => void) =>
  render(
    <table>
      <tbody>
        <HarnessConnectionRows rows={rows} onDetails={onDetails} />
      </tbody>
    </table>,
  );

describe('HarnessConnectionRows', () => {
  afterEach(() => cleanup());

  it('renders nothing when the list has no harness rows, as on the hub', () => {
    const { container } = renderRows([]);
    expect(container.querySelector('[data-testid^="connection-row-harness-"]')).toBeNull();
  });

  it('draws the row the backend sent, under the name the backend chose', () => {
    // The display name is the backend's: `worker.title()` spells "Opencode",
    // and a table that disagrees with the rest of the UI defeats one list.
    renderRows([spec({ provider: 'opencode', display_name: 'OpenCode' })]);
    expect(screen.getByTestId('connection-row-harness-opencode')).toBeTruthy();
    expect(screen.getByTestId('connection-kind-harness-opencode').textContent).toBe('CLI login');
  });

  it('names the account when the vendor named one', () => {
    // The Sign-in column said "CLI login" for every harness, which is the
    // mechanism, not the account. The backend supplies the vendor's own words —
    // rendered verbatim, because a tier name of our own is a claim about billing.
    renderRows([
      spec({ state: ConnectionState.Connected, account: 'Anthropic account · Max', identity: 'a@b.co' }),
    ]);
    const badge = screen.getByTestId('connection-kind-harness-claude');
    expect(badge.textContent).toBe('Anthropic account · Max');
    expect(badge.getAttribute('title')).toBe('a@b.co');
  });

  it('falls back to the mechanism when the vendor says nothing', () => {
    // codex, copilot and opencode answer signed-in/out and nothing more.
    renderRows([spec({ state: ConnectionState.Connected })]);
    expect(screen.getByTestId('connection-kind-harness-claude').textContent).toBe('CLI login');
  });

  it.each([
    [ConnectionState.Unknown, 'Not checked'],
    [ConnectionState.Connected, 'Signed in'],
    [ConnectionState.Disconnected, 'Signed out'],
    [ConnectionState.NeedsReauth, 'Reconnect needed'],
  ])('reports state %s as %s', (state, word) => {
    renderRows([spec({ state })]);
    expect(screen.getByTestId('connection-status-harness-claude').textContent).toBe(word);
  });

  it('carries the backend sentence verbatim, in the title', () => {
    renderRows([spec({ detail: 'sign-in state not checked' })]);
    expect(screen.getByTestId('connection-status-harness-claude').getAttribute('title')).toBe(
      'sign-in state not checked',
    );
  });

  it('asks the host to open the harness status screen for THAT harness', async () => {
    const onDetails = vi.fn();
    renderRows([spec()], onDetails);
    await userEvent.click(screen.getByTestId('connection-harness-details-claude'));
    expect(onDetails).toHaveBeenCalledWith('claude');
  });
});
