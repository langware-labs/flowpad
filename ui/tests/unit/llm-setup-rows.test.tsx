/**
 * The Assistants & keys list: one line per thing that can pay, ONE word per row.
 *
 * The word is what pays — Plan, API key, LLM Endpoint — and only when nothing does, why not:
 * Signed out, Not checked, Not installed. "Signed in" beside "Plan" was the old double answer,
 * and these tests pin the parts of the new one that are easy to get subtly wrong: a word that
 * promises something the row cannot do, a button that names a topic instead of an action, a
 * Details that lands somewhere other than the row it describes, and a tick that silently fails
 * to move.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  setReferenceKind: vi.fn(() => Promise.resolve()),
  login: vi.fn(() => Promise.resolve()),
  cancelLogin: vi.fn(() => Promise.resolve()),
  openPage: vi.fn(),
  openSignIn: vi.fn(),
  resolvedKind: 'harness.claude.cli' as string | null,
  /** The status record's `install` for every harness. */
  install: 'installed',
  /** The status record's FlowPad login. */
  hubLogin: 'signed_out',
  /** Per harness kind, the endpoint typeid the resolver landed on. */
  resolved: {} as Record<string, string>,
  /** The claude harness's own login. */
  claudeLogin: 'not_checked',
  keys: [] as { provider: string; stored: boolean; hint: string }[],
  remaining: {} as Record<string, { limit: number; used: number; remaining: number; window: string; key: string; resets_at: null }>,
}));

const WORKERS = [
  ['claude', true],
  ['codex', true],
  ['copilot', true],
  ['opencode', false],
] as const;

const DEVICE = 'llm_endpoint-00000000-0000-4000-8000-00000000000d';
const KEY = 'llm_endpoint-00000000-0000-4000-8000-00000000000a';
const HUB = 'llm_endpoint-00000000-0000-4000-8000-00000000000b';

/** The status record as the backend serves it. */
function record() {
  return {
    harnesses: WORKERS.map(([w, device]) => ({
      kind: `harness.${w}.cli`,
      worker_type: w,
      label: w,
      icon: '',
      install: h.install,
      version: '',
      path: '',
      login: h.install !== 'installed' ? 'n_a' : !device ? 'n_a' : w === 'claude' ? h.claudeLogin : 'not_checked',
      login_checked_at: '',
      login_message: '',
      account: w === 'claude' && h.claudeLogin === 'signed_in' ? { identity: 'eran@x.io', plan: 'max' } : { identity: '', plan: '' },
      has_device_login: device,
      key_providers: ['openrouter'],
      install_command: '',
      homepage_url: '',
    })),
    keys: h.keys.map((k) => ({ ...k, created_at: '' })),
    hub: { login: h.hubLogin, email: h.hubLogin === 'signed_in' ? 'eran@x.io' : '', user_typeid: '', error: '' },
    default_harness: 'harness.claude.cli',
  };
}

function funding() {
  return {
    resolved: Object.fromEntries(
      WORKERS.map(([w]) => {
        const kind = `harness.${w}.cli`;
        const typeid = h.resolved[kind];
        return [kind, typeid ? { endpoint_typeid: typeid, name: typeid } : null];
      }),
    ),
    endpoints: {
      [DEVICE]: { id: 'd', kind: 'device', name: 'claude device login' },
      [KEY]: { id: 'a', kind: 'api_key', name: 'openrouter key' },
      [HUB]: { id: '00000000-0000-4000-8000-00000000000b', kind: 'hub', name: 'eran default' },
    },
    available: [{ id: '00000000-0000-4000-8000-00000000000b', kind: 'hub', name: 'eran default' }],
    blocked: {},
  };
}

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({
    navigation: { openNewShell: vi.fn(), openDock: vi.fn(), openPage: h.openPage },
    currentDock: null,
  }),
}));
vi.mock('@src/components/wiki-tip/wiki-modal', () => ({ openWikiModal: vi.fn() }));
vi.mock('@src/components/wiki-tip/assistant-wiki', () => ({ useAssistantWikiSpace: () => undefined }));
vi.mock('@src/components/harness-login/harness-sign-in-store', () => ({ openHarnessSignIn: h.openSignIn }));
vi.mock('@src/components/llm-sources/use-hub-remaining', () => ({ useHubRemaining: () => h.remaining }));
vi.mock('@src/components/llm-sources/use-llm-sources', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useLlmSources: () => ({ status: funding(), isLoading: false }),
}));
vi.mock('@src/components/status/use-status-record', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useStatusRecord: () => ({ status: record(), isLoading: false }),
}));
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@sdk/react/hooks', () => ({
  useEntity: () => ({ data: null }),
  usePrimaryContentReady: () => false,
  useCloudStatus: () => ({ cloudUrl: '' }),
}));
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return {
    ...actual,
    cloudManager: { login: h.login, logout: vi.fn(), cancelLogin: h.cancelLogin },
    lmKeysService: { list: () => Promise.resolve([]), listModels: () => Promise.resolve([]), getMappings: () => Promise.resolve({}) },
    statusService: { refresh: () => Promise.resolve(record()) },
    capabilityManager: {
      getSnapshot: () => ({ capability: null, resolvedKind: h.resolvedKind }),
      subscribe: () => () => {},
      // Behaves like the real manager: a successful set moves `resolvedKind`.
      setReferenceKind: (_kind: string, value: string) => {
        h.resolvedKind = value;
        return h.setReferenceKind(_kind, value);
      },
    },
  };
});

import { PageId, ViewType } from '@sdk';
import { HarnessLoginModalRoot } from '@src/components/harness-login/HarnessLoginModal';
import { openHarnessLoginModal, useHarnessLoginStore } from '@src/components/harness-login/harness-login-store';

function mount() {
  openHarnessLoginModal();
  render(<HarnessLoginModalRoot />);
}

const pill = (testId: string) => screen.getByTestId(testId);

describe('Assistants & keys — one row per thing that can pay', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    useHarnessLoginStore.setState({ open: false, payload: null });
    h.resolvedKind = 'harness.claude.cli';
    h.install = 'installed';
    h.hubLogin = 'signed_out';
    h.resolved = {};
    h.claudeLogin = 'not_checked';
    h.keys = [
      { provider: 'openrouter', stored: false, hint: '' },
      { provider: 'anthropic', stored: false, hint: '' },
      { provider: 'openai', stored: false, hint: '' },
    ];
    h.remaining = {};
  });

  it('marks the default assistant, and moves the mark when another is chosen', async () => {
    mount();

    const claude = await screen.findByTestId('harness-row-claude-default');
    const codex = await screen.findByTestId('harness-row-codex-default');
    expect(claude.getAttribute('aria-pressed')).toBe('true');
    expect(codex.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(codex);

    await waitFor(() =>
      expect(screen.getByTestId('harness-row-codex-default').getAttribute('aria-pressed')).toBe('true'),
    );
    expect(screen.getByTestId('harness-row-claude-default').getAttribute('aria-pressed')).toBe('false');
    expect(h.setReferenceKind).toHaveBeenCalledWith('harness', 'harness.codex.cli');
  });

  it('puts the mark back if the backend refuses the change', async () => {
    h.setReferenceKind.mockImplementationOnce(() => {
      h.resolvedKind = 'harness.claude.cli';
      return Promise.reject(new Error('nope'));
    });
    mount();

    fireEvent.click(await screen.findByTestId('harness-row-codex-default'));

    await waitFor(() =>
      expect(screen.getByTestId('harness-row-claude-default').getAttribute('aria-pressed')).toBe('true'),
    );
    expect(screen.getByTestId('harness-row-codex-default').getAttribute('aria-pressed')).toBe('false');
  });

  it('a plan-funded, signed-in assistant reads Plan — never "Signed in" beside it', async () => {
    h.claudeLogin = 'signed_in';
    h.resolved = { 'harness.claude.cli': DEVICE };
    mount();

    const row = await screen.findByTestId('harness-row-claude');
    expect(pill('harness-row-claude-status').getAttribute('data-state')).toBe('plan');
    expect(pill('harness-row-claude-status').textContent).toContain('Plan');
    expect(row.textContent).not.toContain('Signed in');
    // Identity and plan ride the small text, from the status record.
    expect(row.textContent).toContain('eran@x.io');
    expect(row.textContent).toContain('max');
  });

  it('Details on a funded assistant lands on LLM sources focused on it, and closes the modal', async () => {
    h.claudeLogin = 'signed_in';
    h.resolved = { 'harness.claude.cli': DEVICE };
    mount();

    const action = await screen.findByTestId('harness-row-claude-action');
    expect(action.textContent).toContain('Details');
    fireEvent.click(action);

    expect(h.openPage).toHaveBeenCalledWith(PageId.DESK, ViewType.LLM_SOURCES, 'claude');
    await waitFor(() => expect(useHarnessLoginStore.getState().open).toBe(false));
  });

  it('a key-funded assistant that is signed out reads API key, and notes the sign-out beside it', async () => {
    h.claudeLogin = 'signed_out';
    h.resolved = { 'harness.claude.cli': KEY };
    mount();

    const row = await screen.findByTestId('harness-row-claude');
    expect(pill('harness-row-claude-status').getAttribute('data-state')).toBe('api_key');
    expect(row.textContent).toContain('signed out');
  });

  it('a hub-funded assistant reads LLM Endpoint with what is left on it', async () => {
    h.resolved = { 'harness.opencode.cli': HUB };
    h.remaining = { [HUB]: { limit: 3, used: 0.42, remaining: 2.58, window: 'total', key: 'cost_usd_total', resets_at: null } };
    mount();

    const p = await screen.findByTestId('harness-row-opencode-status');
    expect(p.getAttribute('data-state')).toBe('hub');
    expect(p.textContent).toContain('LLM Endpoint');
    expect(p.textContent).toContain('$2.58 left');
  });

  it('nothing funds it and it has a login: Signed out, and the button is Sign in', async () => {
    h.claudeLogin = 'signed_out';
    mount();

    const p = await screen.findByTestId('harness-row-claude-status');
    expect(p.getAttribute('data-state')).toBe('signed_out');
    const action = screen.getByTestId('harness-row-claude-action');
    expect(action.textContent).toContain('Sign in');

    fireEvent.click(action);
    expect(h.openSignIn).toHaveBeenCalledWith('harness.claude.cli');
    await waitFor(() => expect(useHarnessLoginStore.getState().open).toBe(false));
  });

  it('an unprobed login is Not checked, never presumed signed in', async () => {
    mount();
    const p = await screen.findByTestId('harness-row-codex-status');
    expect(p.getAttribute('data-state')).toBe('not_checked');
    expect(p.textContent).not.toContain('Signed in');
  });

  it('says "Not installed" for an assistant whose CLI is missing', async () => {
    h.install = 'not_installed';
    mount();

    const p = await screen.findByTestId('harness-row-claude-status');
    expect(p.textContent).toContain('Not installed');
    expect(p.textContent).not.toContain('Not signed in');
  });

  it('a key-only assistant with no source offers Add key, never a login', async () => {
    mount();

    const action = await screen.findByTestId('harness-row-opencode-action');
    // OpenCode is a client that spends a key; it has no account. Offering "Sign in" there is a
    // promise the row cannot keep — the way forward is the keys section.
    expect(action.textContent).toContain('Add key');
    expect(action.textContent).not.toContain('Sign in');
    fireEvent.click(action);
    expect(h.openPage).toHaveBeenCalledWith(PageId.DESK, ViewType.LLM_SOURCES, 'keys');
  });

  it('the key store is one row: how many slots have a key, with the masked hint of each', async () => {
    h.keys[0] = { provider: 'openrouter', stored: true, hint: '****ab12' };
    mount();

    const p = await screen.findByTestId('row-llm-keys-status');
    expect(p.textContent).toContain('1 of 3 set');
    expect(screen.getByTestId('row-llm-keys').textContent).toContain('****ab12');
    fireEvent.click(screen.getByTestId('row-llm-keys-action'));
    expect(h.openPage).toHaveBeenCalledWith(PageId.DESK, ViewType.LLM_SOURCES, 'keys');
  });

  it('the hub endpoints are one row: how many, and the tightest amount left', async () => {
    h.resolved = { 'harness.opencode.cli': HUB };
    h.remaining = { [HUB]: { limit: 3, used: 0.42, remaining: 2.58, window: 'total', key: 'cost_usd_total', resets_at: null } };
    mount();

    const p = await screen.findByTestId('row-llm-endpoints-status');
    expect(p.textContent).toContain('1 available');
    expect(p.textContent).toContain('$2.58 left');
    fireEvent.click(screen.getByTestId('row-llm-endpoints-action'));
    expect(h.openPage).toHaveBeenCalledWith(PageId.DESK, ViewType.LLM_SOURCES, 'endpoints');
  });

  it('lets FlowPad be signed in to, and never offers to sign out from here', async () => {
    mount();

    const action = await screen.findByTestId('harness-row-flowpad-action');
    expect(action.textContent).toContain('Sign in');
    expect(action.textContent).not.toContain('Sign out');

    fireEvent.click(action);
    await waitFor(() => expect(h.login).toHaveBeenCalled());
  });

  it('a click on the row itself starts no sign-in; the pill and the button each start one', async () => {
    mount();

    fireEvent.click(await screen.findByTestId('harness-row-flowpad'));
    expect(h.login).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('harness-row-flowpad-action'));
    await waitFor(() => expect(h.login).toHaveBeenCalledTimes(1));
  });

  it('while signing in, says where to finish, and offers the page again or a way out', async () => {
    h.hubLogin = 'signing_in';
    mount();

    const waiting = await screen.findByTestId('harness-row-flowpad-waiting');
    expect(waiting.textContent).toContain('browser');

    fireEvent.click(screen.getByTestId('harness-row-flowpad-cancel'));
    expect(h.cancelLogin).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('harness-row-flowpad-reopen'));
    expect(h.login).toHaveBeenCalledTimes(1);
  });

  it('signed in: says so, names the account and what it funds, and Details goes to the endpoints', async () => {
    h.hubLogin = 'signed_in';
    h.resolved = { 'harness.opencode.cli': HUB };
    mount();

    const row = await screen.findByTestId('harness-row-flowpad');
    expect(screen.getByTestId('harness-row-flowpad-status').textContent).toContain('Signed in');
    expect(row.textContent).toContain('eran@x.io');
    expect(row.textContent).toContain('funds opencode');
    expect(screen.getByTestId('harness-row-flowpad-action').textContent).not.toContain('Sign in');

    fireEvent.click(screen.getByTestId('harness-row-flowpad-action'));
    expect(h.login).not.toHaveBeenCalled();
    expect(h.openPage).toHaveBeenCalledWith(PageId.DESK, ViewType.LLM_SOURCES, 'endpoints');
  });

  it('keeps the Mapping view open when the dialog is re-opened underneath you', async () => {
    mount();

    fireEvent.click(await screen.findByTestId('open-mapping'));
    await screen.findByTestId('mapping-harness-select');

    // `LlmSetupView` opens this modal from a mount effect, so anything that re-mounts it calls
    // open() again. A redundant open() must never discard where the user navigated to.
    openHarnessLoginModal();

    await waitFor(() => expect(screen.queryByTestId('mapping-harness-select')).not.toBeNull());
  });
});
