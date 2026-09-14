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
  checkHarnessLogins: vi.fn(),
  save: vi.fn(() => Promise.resolve({ typeid: 'credential_spec-new', title: 'Twilio', project_id: null })),
  remove: vi.fn(() => Promise.resolve({ deleted: ['TWILIO_SID'], kept: [] as string[] })),
  refresh: vi.fn(() => Promise.resolve()),
  status: { project_id: null, vault_enabled: true, credentials: [], files: [] } as Record<string, unknown>,
  templates: [] as unknown[],
  rows: [] as unknown[],
  blocked: false,
  connections: null as unknown[] | null,
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
vi.mock('@src/components/credentials/use-credentials', () => ({
  useCredentials: () => ({ status: h.status, templates: h.templates, ready: true, refresh: h.refresh }),
}));
vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  credentialsService: { save: h.save, remove: h.remove, setValues: vi.fn(), status: vi.fn() },
}));
// The consolidated read. Stubbed rather than provided with a QueryClient: this
// file is about the table's own producers, and the harness rows it feeds are
// presenters covered by their own file. `null` is also the real hub answer, so
// the component takes the same path it takes off-desk.
vi.mock('@src/hooks/use-connections', () => ({
  useConnections: () => ({ connections: h.connections, isLoading: false, refetch: vi.fn() }),
  useCheckHarnessLogins: () => h.checkHarnessLogins(),
}));
// `useDockNavigation` reaches `useNavigate()`, which needs a Router this file does
// not render. The host owns navigation so the harness rows can stay presenters.
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: {}, currentDock: null }),
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

  it('names the grant and lists the scopes it will request', async () => {
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

    // One chip and a count, not a stack: four chips wrapped the row to four
    // lines and pushed Status and Actions out of view. The rest is a hover away.
    const cell = screen.getByTestId('connection-scopes-github');
    expect(cell.textContent).toBe('repo+1');

    // And the hover actually reveals them. This used to be a native `title`,
    // which asks for a second of stillness and often never appeared in the
    // desktop shell at all — so the count read as a dead end.
    await userEvent.hover(cell.querySelector('[tabindex]') as HTMLElement);
    await waitFor(() => {
      expect(screen.getAllByText('read:org').length).toBeGreaterThan(0);
    });
  });

  it('asks the box to check the harness logins', () => {
    // This screen is where a person comes to find out whether they are signed
    // in, and the harness rows read "Not checked" until someone asks the vendor
    // CLIs. Asking is a separate verb because it WRITES — the same list read
    // resolves `require()` and must not spawn subprocesses.
    render(<ConnectionsManager projectTypeId={PROJECT} />);

    expect(h.checkHarnessLogins).toHaveBeenCalled();
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

const TWILIO_TEMPLATE = {
  id: 'spec-twilio',
  name: 'twilio',
  title: 'Twilio',
  description: '',
  icon_name: '',
  help_url: '',
  value_store: 'env',
  lm_provider: '',
  scope: 'system',
  vars: { TWILIO_SID: { label: 'Account SID', required: true } },
  varNames: ['TWILIO_SID'],
};

const statusWith = (over: Record<string, unknown> = {}) => ({
  project_id: null,
  vault_enabled: true,
  credentials: [],
  files: [],
  ...over,
});

const credential = (over: Record<string, unknown> = {}) => ({
  typeid: 'credential_spec-1',
  name: 'twilio',
  title: 'Twilio',
  description: '',
  icon_name: '',
  help_url: '',
  scope: 'user',
  project_id: null,
  value_store: 'env',
  lm_provider: '',
  state: 'connected',
  vars: [
    {
      env_var: 'TWILIO_SID', label: 'SID', hint: '', placeholder: '', pattern: '', help_url: '',
      secret: false, required: true, present: true, found_in: 'env', warning: null, shadowed_by: null,
    },
  ],
  ...over,
});

const resetCredentials = () => {
  vi.clearAllMocks();
  localStorage.clear();
  h.providers = [];
  h.statuses = {};
  h.grants = {};
  h.projects = [];
  h.usage = {};
  h.templates = [TWILIO_TEMPLATE];
  h.status = statusWith();
};

const openTemplate = async () => {
  await userEvent.click(screen.getByTestId('add-connection-open'));
  await userEvent.click(screen.getByTestId('add-connection-twilio'));
};

describe('ConnectionsManager — adding a credential', () => {
  beforeEach(resetCredentials);
  afterEach(() => cleanup());

  it('a catalogue template opens the one credential form with its variable fixed', async () => {
    render(<ConnectionsManager projectTypeId={PROJECT} />);
    await openTemplate();

    expect(screen.getByTestId('credential-dialog')).toBeTruthy();
    expect(screen.getByTestId('credential-var-name-0').tagName).toBe('CODE');
    expect(h.save).not.toHaveBeenCalled();
  });

  it('saving writes the declaration and its values in one call, then re-reads', async () => {
    render(<ConnectionsManager projectTypeId={PROJECT} />);
    await openTemplate();

    await userEvent.type(screen.getByTestId('credential-var-value-0'), 'sid-1');
    await userEvent.click(screen.getByTestId('credential-save'));

    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    expect(h.save).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'user',
        project_id: null,
        manifest: expect.objectContaining({ name: 'twilio', value_store: 'env' }),
        values: { TWILIO_SID: 'sid-1' },
      }),
    );
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
  });

  it('with a project selected, a new credential defaults to that project', async () => {
    render(<ConnectionsManager projectTypeId={PROJECT} project={{ id: 'p1', typeId: PROJECT } as never} />);
    await openTemplate();

    await userEvent.type(screen.getByTestId('credential-var-value-0'), 'sid-1');
    await userEvent.click(screen.getByTestId('credential-save'));

    await waitFor(() => expect(h.save).toHaveBeenCalled());
    expect(h.save.mock.calls[0][0]).toMatchObject({ scope: 'project', project_id: 'p1' });
  });

  it('Custom credentials opens a name and name + value pairs, the rest behind Advanced', async () => {
    render(<ConnectionsManager projectTypeId={PROJECT} project={{ id: 'p1', typeId: PROJECT } as never} />);
    await userEvent.click(screen.getByTestId('add-connection-open'));
    await userEvent.click(screen.getByTestId('add-connection-custom'));

    expect(screen.getByTestId('credential-title')).toBeTruthy();
    expect(screen.getByTestId('credential-var-name-0').tagName).toBe('INPUT');
    expect(screen.getByTestId('credential-var-value-0')).toBeTruthy();
    expect(screen.queryByTestId('credential-advanced')).toBeNull();

    await userEvent.click(screen.getByTestId('credential-advanced-toggle'));

    // Defaults: this project, the .env.local file — each with its wiki section.
    expect(screen.getByTestId('credential-scope').textContent).toMatch(/this project/i);
    expect(screen.getByTestId('credential-store').textContent).toMatch(/\.env\.local/i);
    expect(screen.getByTestId('credential-scope-info')).toBeTruthy();
    expect(screen.getByTestId('credential-store-info')).toBeTruthy();
    expect(screen.getByTestId('credential-description')).toBeTruthy();
  });

  it('refuses to write a value into a committable .env.local, and says why', async () => {
    h.status = statusWith({
      files: [
        {
          scope: 'user', project_id: null, path: '/h/.env.local', exists: true, blocked: true,
          block_code: 'tracked', block_reason: '.env.local is already TRACKED by git.', detected: [],
        },
      ],
    });
    render(<ConnectionsManager projectTypeId={PROJECT} />);
    await openTemplate();
    await userEvent.type(screen.getByTestId('credential-var-value-0'), 'sid-1');

    expect(screen.getByTestId('env-local-blocked-notice').textContent).toMatch(/TRACKED/);
    expect(screen.getByTestId('credential-save').hasAttribute('disabled')).toBe(true);
  });

  it('a vault credential asks for the vault to be enabled first', async () => {
    h.status = statusWith({ vault_enabled: false });
    h.templates = [{ ...TWILIO_TEMPLATE, value_store: 'vault' }];
    render(<ConnectionsManager projectTypeId={PROJECT} />);
    await openTemplate();

    expect(screen.getByTestId('vault-disabled-notice')).toBeTruthy();
    expect(screen.getByTestId('credential-save').hasAttribute('disabled')).toBe(true);
  });

  it('packing detected keys opens the form with those names and no value fields', async () => {
    h.status = statusWith({
      files: [
        {
          scope: 'user', project_id: null, path: '/h/.env.local', exists: true, blocked: false,
          block_code: null, block_reason: null,
          detected: [
            { key: 'QA_A', line: 1 },
            { key: 'QA_B', line: 2 },
          ],
        },
      ],
    });
    render(<ConnectionsManager projectTypeId={PROJECT} />);

    await userEvent.click(screen.getByTestId('detected-key-user-QA_A'));
    await userEvent.click(screen.getByTestId('detected-pack-user'));

    expect(screen.getByTestId('credential-var-name-0').textContent).toBe('QA_A');
    expect(screen.queryByTestId('credential-var-value-0')).toBeNull();

    await userEvent.type(screen.getByTestId('credential-title'), 'QA pack');
    await userEvent.click(screen.getByTestId('credential-save'));

    await waitFor(() => expect(h.save).toHaveBeenCalled());
    expect(h.save.mock.calls[0][0]).toMatchObject({ scope: 'user', values: {} });
    expect(Object.keys((h.save.mock.calls[0][0] as { manifest: { vars: object } }).manifest.vars)).toEqual(['QA_A']);
  });
});

describe('ConnectionsManager — credential rows', () => {
  beforeEach(() => {
    resetCredentials();
    h.status = statusWith({ credentials: [credential({ value_store: 'vault' })] });
  });
  afterEach(() => cleanup());

  const openMenuItem = async (key: string, item: 'edit' | 'delete') => {
    await userEvent.click(screen.getByTestId(`connection-more-${key}`));
    await userEvent.click(await screen.findByTestId(`connection-${item}-${key}`));
  };

  it('lists a declared credential with where its values live and who gets it', () => {
    render(<ConnectionsManager projectTypeId={PROJECT} />);

    expect(screen.getByTestId('connection-row-user-twilio')).toBeTruthy();
    expect(screen.getByTestId('connection-store-user-twilio').textContent).toMatch(/vault/i);
    expect(screen.getByTestId('connection-scope-user-twilio').textContent).toMatch(/all projects/i);
  });

  it('a credential missing values offers to set them, and asks only for values', async () => {
    h.status = statusWith({
      credentials: [
        credential({
          state: 'missing',
          vars: [{ ...(credential().vars as object[])[0], present: false, found_in: null, warning: 'missing' }],
        }),
      ],
    });
    render(<ConnectionsManager projectTypeId={PROJECT} />);

    expect(screen.getByTestId('connection-status-user-twilio').textContent).toMatch(/needs values/i);
    await userEvent.click(screen.getByTestId('connection-setvalues-user-twilio'));

    expect(screen.getByTestId('credential-var-value-0')).toBeTruthy();
    expect(screen.queryByTestId('credential-title')).toBeNull();
  });

  it('deleting a vault credential says its values are deleted', async () => {
    render(<ConnectionsManager projectTypeId={PROJECT} />);
    await openMenuItem('user-twilio', 'delete');

    expect(document.body.textContent).toMatch(/deleted from the vault/i);
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(h.remove).toHaveBeenCalledWith('credential_spec-1'));
  });

  it('deleting an env-file credential names the lines that stay', async () => {
    h.status = statusWith({ credentials: [credential({ value_store: 'env' })] });
    render(<ConnectionsManager projectTypeId={PROJECT} />);
    await openMenuItem('user-twilio', 'delete');

    const text = document.body.textContent ?? '';
    expect(text).toMatch(/TWILIO_SID stay in \.env\.local/i);
    expect(text).not.toMatch(/deleted from the vault/i);
  });
});
