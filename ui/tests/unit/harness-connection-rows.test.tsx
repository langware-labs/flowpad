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
    expect(screen.getByTestId('connection-kind-harness-opencode').dataset.method).toBe('device');
  });

  it('shows the method as the cell, and the account in its tooltip', () => {
    // The Sign-in column answers HOW — a device login — and nothing else. The
    // vendor's own words for the account ride in the tooltip, verbatim, because
    // a tier name of our own would be a claim about billing.
    renderRows([
      spec({ state: ConnectionState.Connected, account: 'Anthropic account · Max', identity: 'a@b.co' }),
    ]);
    const icon = screen.getByTestId('connection-kind-harness-claude');
    expect(icon.dataset.method).toBe('device');
    expect(icon.getAttribute('aria-label')).toBe('Device login — Anthropic account · Max — a@b.co');
  });

  it('says only the method when the vendor says nothing', () => {
    // codex, copilot and opencode answer signed-in/out and nothing more.
    renderRows([spec({ state: ConnectionState.Connected })]);
    expect(screen.getByTestId('connection-kind-harness-claude').getAttribute('aria-label')).toBe('Device login');
  });

  it.each([
    [ConnectionState.Unknown, 'Not checked'],
    // The table's one vocabulary — the same words the OAuth and FlowPad rows use.
    [ConnectionState.Connected, 'Connected'],
    [ConnectionState.Disconnected, 'Not connected'],
    [ConnectionState.NeedsReauth, 'Reconnect needed'],
  ])('reports state %s as %s', (state, word) => {
    renderRows([spec({ state })]);
    expect(screen.getByTestId('connection-status-harness-claude').textContent).toBe(word);
  });

  it('takes the method from the backend: a key-funded harness is an API key', () => {
    // Deep Agents has no account of its own; a device-login icon on it was a claim
    // about a sign-in that cannot exist.
    renderRows([spec({ provider: 'deepagents', display_name: 'Deep Agents', sign_in: 'api_key' })]);
    expect(screen.getByTestId('connection-kind-harness-deepagents').dataset.method).toBe('api_key');
  });

  it('draws no vendor mark it does not have — never Claude\'s for someone else', () => {
    renderRows([spec({ provider: 'deepagents', display_name: 'Deep Agents' })]);
    const row = screen.getByTestId('connection-row-harness-deepagents');
    expect(row.querySelector('.lucide-bot')).not.toBeNull();
  });

  it('says a machine-level login is used by every project, not "—"', () => {
    renderRows([spec()]);
    expect(screen.getByTestId('connection-row-harness-claude').textContent).toContain('All projects');
  });

  it('quiets Details while signed in and outlines it when the login needs you', () => {
    renderRows([spec({ state: ConnectionState.Connected })]);
    expect(screen.getByTestId('connection-harness-details-claude').className).not.toMatch(/\bborder\b/);
    cleanup();
    renderRows([spec({ state: ConnectionState.Disconnected })]);
    expect(screen.getByTestId('connection-harness-details-claude').className).toMatch(/\bborder\b/);
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
