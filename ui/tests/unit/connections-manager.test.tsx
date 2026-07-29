/**
 * `ConnectionsManager` — now frameless and told which project a token attaches to.
 *
 * Two behaviours worth pinning beyond the refactor: without a project it must
 * REFUSE rather than start a flow whose token has nowhere to land (it used to
 * raise a browser `alert()`), and the connect button's meaning changes with
 * status — a disconnected provider runs the full OAuth flow, an available one
 * only attaches.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  connect: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
  notifyError: vi.fn(),
  providers: [{ name: 'github', display_name: 'GitHub', icon: undefined }] as unknown[],
  statuses: {} as Record<string, string>,
}));

vi.mock('@sdk/react/hooks/useOAuthConnection', () => ({
  useOAuthConnection: () => ({
    connectingConnectionId: null,
    availableProviders: h.providers,
    connectionStatuses: h.statuses,
    connect: h.connect,
    attach: h.attach,
    detach: h.detach,
  }),
}));
vi.mock('@src/notifications', () => ({ notify: { error: h.notifyError, success: vi.fn() } }));

import { ConnectionsManager } from '@src/components/connections-manager';

const PROJECT = { type: 'project', id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' } as never;

describe('ConnectionsManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    h.statuses = { github: 'DISCONNECTED' };
  });
  afterEach(() => cleanup());

  it('owns no frame, and takes a className', () => {
    render(<ConnectionsManager projectTypeId={PROJECT} className="h-full p-4" />);
    const root = screen.getByTestId('connections-manager');

    expect(root.className).toContain('h-full');
    // The host decides height and padding; the component must not bake them in.
    expect(root.className).not.toMatch(/\bp-4\b.*\bp-4\b/);
  });

  it('hides its heading when the host supplies one', () => {
    const { rerender } = render(<ConnectionsManager projectTypeId={PROJECT} />);
    expect(screen.queryByText('OAuth Connections')).toBeTruthy();

    rerender(<ConnectionsManager projectTypeId={PROJECT} header={false} />);
    expect(screen.queryByText('OAuth Connections')).toBeNull();
  });

  it('refuses without a project, and does not start a flow', async () => {
    render(<ConnectionsManager />);

    await userEvent.click(screen.getByRole('button', { name: /connect/i }));

    expect(h.connect).not.toHaveBeenCalled();
    expect(h.attach).not.toHaveBeenCalled();
    expect(h.notifyError).toHaveBeenCalled();
  });

  it('runs the full flow when disconnected, and only attaches when the token exists', async () => {
    const { rerender } = render(<ConnectionsManager projectTypeId={PROJECT} />);

    await userEvent.click(screen.getByRole('button', { name: /connect/i }));
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.attach).not.toHaveBeenCalled();

    h.statuses = { github: 'AVAILABLE' };
    rerender(<ConnectionsManager projectTypeId={PROJECT} key="2" />);

    await userEvent.click(screen.getByRole('button', { name: /connect/i }));
    expect(h.attach).toHaveBeenCalledTimes(1);
  });

  it('detaches a connected provider', async () => {
    h.statuses = { github: 'CONNECTED' };
    render(<ConnectionsManager projectTypeId={PROJECT} />);

    await userEvent.click(screen.getByRole('button', { name: /disconnect/i }));

    expect(h.detach).toHaveBeenCalledTimes(1);
  });

  it('says so when there are no providers', () => {
    h.providers = [];
    render(<ConnectionsManager projectTypeId={PROJECT} />);

    expect(screen.getByText(/No OAuth connections found/i)).toBeTruthy();
    h.providers = [{ name: 'github', display_name: 'GitHub', icon: undefined }];
  });

  it('names the grant and lists the scopes it will request', () => {
    // The two things a user needs before granting: which flow runs, and what it
    // will be allowed to do. Both used to be invisible.
    h.providers = [
      { name: 'github', display_name: 'GitHub', kind: 'code', scopes: ['repo', 'read:org'] },
      { name: 'anthropic', display_name: 'Anthropic', kind: 'loopback', scopes: ['user:profile'] },
    ] as unknown[];
    render(<ConnectionsManager projectTypeId={PROJECT} />);

    expect(screen.getByTestId('connection-kind-github').textContent).toBe('OAuth');
    expect(screen.getByTestId('connection-kind-anthropic').textContent).toBe('OAuth + PKCE');

    const scopes = screen.getByTestId('connection-scopes-github').textContent;
    expect(scopes).toContain('repo');
    expect(scopes).toContain('read:org');
  });

  it('does not claim "no scopes" when the owning side never published them', () => {
    // A hub provider's scopes live in its manifest, which the table does not
    // carry. Rendering an empty list would assert something false.
    h.providers = [{ name: 'slack', display_name: 'slack', kind: 'code' }] as unknown[];
    render(<ConnectionsManager projectTypeId={PROJECT} />);

    expect(screen.getByTestId('connection-scopes-slack').textContent).toContain('Shown at approval');
  });
});
