/**
 * `ConnectionsManager` — the table over a credential's two sides.
 *
 * The distinction this file exists to pin: a **grant** (the user holds a token)
 * and a **placement** (a project may use it) are different things. Connect makes
 * a grant and needs no project — it used to refuse outright without one, which
 * made every row a dead end on the hub, where a user can hold zero projects.
 * Attach/detach are placements and do need one. And deleting the credential is
 * neither: it is a third, confirmed act that must never happen implicitly.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  connect: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
  disconnect: vi.fn(),
  notifyError: vi.fn(),
  providers: [{ name: 'github', display_name: 'GitHub', icon: undefined }] as unknown[],
  statuses: {} as Record<string, string>,
  grants: {} as Record<string, string>,
  projects: [] as unknown[],
  usage: {} as Record<string, unknown[]>,
  declare: vi.fn(async () => undefined),
  provide: vi.fn(async () => undefined),
  stopDeclaring: vi.fn(async () => undefined),
  rows: [] as unknown[],
  blocked: false,
}));

// Spread the original: the barrel `@sdk/react/hooks` re-exports this module, so
// a bare object mock would also erase `GrantStatus`/`deriveConnectionStatus` from
// the barrel the component imports them through.
vi.mock('@sdk/react/hooks/useOAuthConnection', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOAuthConnection: () => ({
    connectingConnectionId: null,
    availableProviders: h.providers,
    connectionStatuses: h.statuses,
    grantStatuses: h.grants,
    userTable: { values: [] },
    connect: h.connect,
    attach: h.attach,
    detach: h.detach,
    disconnect: h.disconnect,
  }),
}));
vi.mock('@src/hooks/use-projects', () => ({ useProjects: () => ({ projects: h.projects, isLoading: false }) }));
// The usage fan-out has its own test; here it is a fixture so the table's own
// behaviour is what's under test.
vi.mock('@src/components/connections-manager/use-credential-usage', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useCredentialUsage: () => ({ usage: h.usage, isLoading: false, isEnabled: true, isComplete: true }),
}));
// The credential half is a fixture here: this file is about the table, and the
// fold itself is covered by `credential-rows.test.ts`.
vi.mock('@src/components/connections-manager/use-credential-connections', () => ({
  useCredentialConnections: () => ({
    rows: h.rows,
    specs: [
      {
        id: 'spec-twilio',
        name: 'twilio',
        title: 'Twilio',
        vars: { TWILIO_SID: { label: 'Account SID', required: true } },
        // A real `CredentialSpec` exposes `varNames`; the form reads variables
        // through it so the set it ASKS for cannot drift from the set
        // `pointersFor` declares.
        varNames: ['TWILIO_SID'],
      },
    ],
    envLocalBlocked: h.blocked,
    envLocalPresent: new Set<string>(),
    declareCredential: h.declare,
    provide: h.provide,
    stopDeclaring: h.stopDeclaring,
  }),
}));
vi.mock('@src/notifications', () => ({
  notify: { error: h.notifyError, success: vi.fn(), info: vi.fn() },
}));

import { ConnectionsManager } from '@src/components/connections-manager';

const PROJECT = { type: 'project', id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' } as never;
const ALPHA = { id: 'p1', name: 'Alpha', displayName: 'Alpha', typeId: PROJECT };

describe('ConnectionsManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    h.statuses = { github: 'DISCONNECTED' };
    h.grants = { github: 'none' };
    h.projects = [];
    h.usage = {};
    h.blocked = false;
    h.rows = [];
    h.providers = [{ name: 'github', display_name: 'GitHub', icon: undefined }];
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
    expect(screen.queryByRole('heading', { name: 'Connections' })).toBeTruthy();

    rerender(<ConnectionsManager projectTypeId={PROJECT} header={false} />);
    expect(screen.queryByRole('heading', { name: 'Connections' })).toBeNull();
  });

  it('grants without a project instead of refusing — the token is the user’s', async () => {
    // The inverted case. A grant is user-scoped on both backends (neither `auth`
    // handler reads a target entity), so with no project this must run the flow,
    // not raise "No project selected" at a user who has no project to select.
    //
    // Driven from the Add dialog, because that is where connecting something for
    // the first time now begins: the table lists only what you hold.
    render(<ConnectionsManager />);

    await userEvent.click(screen.getByTestId('add-connection-open'));
    await userEvent.click(screen.getByTestId('add-connection-github'));

    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.attach).not.toHaveBeenCalled();
    expect(h.notifyError).not.toHaveBeenCalled();
  });

  it('calls a held credential Connected — the Status column is about the account, not a project', () => {
    // It used to read "Ready to connect" here, because the column showed the
    // per-project status: with no project attached, a credential you are holding
    // rendered as if you had none. Placement is the Used-by column's job.
    h.grants = { github: 'held' };
    h.statuses = { github: 'AVAILABLE' };
    render(<ConnectionsManager />);

    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.queryByText('Ready to connect')).toBeNull();
  });

  it('offers no placement affordance when there is no project to place into', () => {
    h.grants = { github: 'held' };
    h.statuses = { github: 'AVAILABLE' };
    render(<ConnectionsManager />);

    // Absent, not disabled-with-an-error: there is nothing to explain.
    expect(screen.queryByTestId('connection-attach-github')).toBeNull();
    expect(screen.queryByTestId('connection-detach-github')).toBeNull();
  });

  it('separates the grant from the placement', async () => {
    // No credential → the row does not exist; Connect runs the full flow from
    // the Add dialog.
    const { rerender } = render(<ConnectionsManager projectTypeId={PROJECT} />);
    await userEvent.click(screen.getByTestId('add-connection-open'));
    await userEvent.click(screen.getByTestId('add-connection-github'));
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.attach).not.toHaveBeenCalled();

    // Credential held, this project not attached → attach only, no new grant.
    h.grants = { github: 'held' };
    h.statuses = { github: 'AVAILABLE' };
    rerender(<ConnectionsManager projectTypeId={PROJECT} key="2" />);

    await userEvent.click(screen.getByTestId('connection-attach-github'));
    expect(h.attach).toHaveBeenCalledTimes(1);
    expect(h.connect).toHaveBeenCalledTimes(1);
  });

  it('detaches a connected provider without destroying the credential', async () => {
    h.grants = { github: 'held' };
    h.statuses = { github: 'CONNECTED' };
    render(<ConnectionsManager projectTypeId={PROJECT} />);

    await userEvent.click(screen.getByTestId('connection-detach-github'));

    expect(h.detach).toHaveBeenCalledTimes(1);
    // The regression that matters: removing the last placement is not a delete.
    expect(h.disconnect).not.toHaveBeenCalled();
  });

  it('says so when there is nothing connected', () => {
    // The table holds credentials as well as OAuth providers now, so the empty
    // state can no longer speak only of OAuth.
    h.providers = [];
    render(<ConnectionsManager projectTypeId={PROJECT} />);

    expect(screen.getByText(/No connections yet/i)).toBeTruthy();
  });

  it('names the grant and lists the scopes it will request', () => {
    // The two things a user needs before granting: which flow runs, and what it
    // will be allowed to do. Both used to be invisible.
    h.providers = [
      { name: 'github', display_name: 'GitHub', kind: 'code', scopes: ['repo', 'read:org'] },
      { name: 'anthropic', display_name: 'Anthropic', kind: 'loopback', scopes: ['user:profile'] },
    ] as unknown[];
    // Held: these are row facts, and only held providers are rows.
    h.grants = { github: 'held', anthropic: 'held' };
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
    h.grants = { slack: 'held' };
    render(<ConnectionsManager projectTypeId={PROJECT} />);

    expect(screen.getByTestId('connection-scopes-slack').textContent).toContain('Shown at approval');
  });
});

describe('ConnectionsManager — where a credential is used', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    h.providers = [{ name: 'github', display_name: 'GitHub', icon: undefined }];
    h.statuses = { github: 'CONNECTED' };
    h.grants = { github: 'held' };
    h.projects = [ALPHA];
    h.usage = {};
    h.blocked = false;
    h.rows = [];
  });
  afterEach(() => cleanup());

  it('says a held credential is unused rather than leaving the cell blank', () => {
    render(<ConnectionsManager projectTypeId={PROJECT} />);
    expect(screen.getByTestId('connection-usage-github').textContent).toContain('Not used yet');
  });

  it('names the projects that use it', () => {
    h.usage = { github: [ALPHA] };
    render(<ConnectionsManager projectTypeId={PROJECT} />);
    expect(screen.getByTestId('connection-usage-github').textContent).toContain('Alpha');
  });

  it('shows nothing to manage for a credential the user does not hold', () => {
    h.grants = { github: 'none' };
    h.statuses = { github: 'DISCONNECTED' };
    render(<ConnectionsManager projectTypeId={PROJECT} />);
    expect(screen.queryByTestId('connection-usage-trigger')).toBeNull();
    // Stronger than it used to be: there is no row to manage anything on.
    expect(screen.queryByTestId('connection-kind-github')).toBeNull();
  });

  it('lists only what you hold, and offers the rest in Add connection', async () => {
    // The table and the dialog are complements, not overlapping lists. A
    // provider used to be in both at once: a "Not connected" row you could not
    // act on, beside a tile offering to add the very same thing.
    h.providers = [
      { name: 'github', display_name: 'GitHub' },
      { name: 'slack', display_name: 'Slack' },
    ] as unknown[];
    h.grants = { github: 'held' };
    render(<ConnectionsManager projectTypeId={PROJECT} />);

    expect(screen.getByTestId('connection-kind-github')).toBeTruthy();
    expect(screen.queryByTestId('connection-kind-slack')).toBeNull();

    await userEvent.click(screen.getByTestId('add-connection-open'));
    expect(screen.getByTestId('add-connection-slack')).toBeTruthy();
    expect(screen.queryByTestId('add-connection-github')).toBeNull();
  });
});

describe('ConnectionsManager — a credential that is held but dead', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    h.providers = [{ name: 'googledrive', display_name: 'Google Drive', icon: undefined }];
    h.statuses = { googledrive: 'NEEDS_REAUTH' };
    h.grants = { googledrive: 'needs_reauth' };
    h.projects = [];
    h.usage = {};
    h.blocked = false;
    h.rows = [];
  });
  afterEach(() => cleanup());

  it('says reconnect is needed rather than claiming a connection', () => {
    render(<ConnectionsManager projectTypeId={PROJECT} />);
    expect(screen.getByText('Reconnect needed')).toBeTruthy();
    expect(screen.queryByText('Connected')).toBeNull();
  });

  it('runs the full flow, not attach — attaching would re-share the refused token', async () => {
    render(<ConnectionsManager projectTypeId={PROJECT} />);
    await userEvent.click(screen.getByRole('button', { name: /reconnect/i }));
    expect(h.connect).toHaveBeenCalledWith('googledrive', 'googledrive');
    expect(h.attach).not.toHaveBeenCalled();
  });
});

describe('ConnectionsManager — adding a credential writes the key', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    h.providers = [];
    h.statuses = {};
    h.grants = {};
    h.projects = [];
    h.usage = {};
    h.blocked = false;
    h.rows = [];
  });
  afterEach(() => cleanup());

  it('asks for the values before declaring anything', async () => {
    // Declaring an empty shell was the bug: it produced a "connection" that
    // connects nothing and — because a credential exists when its values do —
    // does not even render as a row afterwards.
    render(<ConnectionsManager projectTypeId={PROJECT} />);

    await userEvent.click(screen.getByTestId('add-connection-open'));
    await userEvent.click(screen.getByTestId('add-connection-twilio'));

    expect(screen.getByTestId('credential-value-form')).toBeTruthy();
    expect(h.declare).not.toHaveBeenCalled();
  });

  it('declares before it provides — the pointer must exist first', async () => {
    render(<ConnectionsManager projectTypeId={PROJECT} />);
    await userEvent.click(screen.getByTestId('add-connection-open'));
    await userEvent.click(screen.getByTestId('add-connection-twilio'));

    await userEvent.type(screen.getByTestId('credential-value-TWILIO_SID'), 'sid-1');
    await userEvent.click(screen.getByTestId('credential-value-save'));

    await waitFor(() => expect(h.provide).toHaveBeenCalled());
    // `provide-secret` resolves the pointer on the project, so a value written
    // before the declaration has nowhere to land.
    expect(h.declare.mock.invocationCallOrder[0]).toBeLessThan(
      h.provide.mock.invocationCallOrder[0],
    );
    expect(h.provide).toHaveBeenCalledWith({ envVar: 'TWILIO_SID', value: 'sid-1' });
  });

  it('refuses, and says why, when .env.local is committable', async () => {
    h.blocked = true;
    render(<ConnectionsManager projectTypeId={PROJECT} />);

    expect(screen.getAllByTestId('env-local-blocked-notice').length).toBeGreaterThan(0);

    await userEvent.click(screen.getByTestId('add-connection-open'));
    await userEvent.click(screen.getByTestId('add-connection-twilio'));
    // Shown again inside the modal, which covers the table's copy.
    expect(screen.getAllByTestId('env-local-blocked-notice').length).toBe(2);
    expect((screen.getByTestId('credential-value-save') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('ConnectionsManager — withdrawing a declaration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    h.providers = [];
    h.grants = {};
    h.projects = [];
    h.usage = {};
    h.blocked = false;
    h.rows = [
      {
        key: 'twilio',
        title: 'Twilio',
        state: 'connected',
        declaredCount: 2,
        adoptableCount: 0,
        members: [
          { envVar: 'TWILIO_SID', label: 'SID', secret: false, required: true, state: 'met', declared: true, typeid: 'secret_origin-1' },
        ],
      },
    ] as unknown[];
  });
  afterEach(() => cleanup());

  it('offers to stop declaring, and says the value is not deleted', async () => {
    // Without this there is no way to un-declare anything in the app at all —
    // the row is permanent, and so is its entry in the machine's attachable
    // secrets list.
    render(<ConnectionsManager projectTypeId={PROJECT} />);
    await userEvent.click(screen.getByTestId('connection-stop-declaring-twilio'));

    // `.env.local` is append-only by policy, so the confirmation must not
    // promise a deletion it cannot perform.
    expect(document.body.textContent).toMatch(/stays in \.env\.local/i);

    await userEvent.click(screen.getByRole('button', { name: /^stop declaring$/i }));
    await waitFor(() => expect(h.stopDeclaring).toHaveBeenCalledTimes(1));
  });
});
