/**
 * The Assistants & keys list, after it became ONE list.
 *
 * FlowPad, the four assistants and the LLM-key store used to be drawn three different ways in
 * three stacked sections. They answer the same question — what pays for your LLM calls — so
 * they now share one row shape and one vocabulary. These tests pin the parts of that which are
 * easy to get subtly wrong and impossible to notice: a word that promises something the row
 * cannot do, and a tick that silently fails to move.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  setReferenceKind: vi.fn(() => Promise.resolve()),
  login: vi.fn(() => Promise.resolve()),
  resolvedKind: 'harness.claude.cli' as string | null,
  /** `checked && available` is what the modal turns into "installed". */
  available: true,
  loginState: null as string | null,
  cloudStatus: 'logged_out' as string,
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openNewShell: vi.fn(), openDock: vi.fn() }, currentDock: null }),
}));
vi.mock('@src/components/wiki-tip/wiki-modal', () => ({ openWikiModal: vi.fn() }));
vi.mock('@src/components/llm-endpoints/llm-endpoints-pointer', () => ({ openLlmEndpoint: vi.fn() }));
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@sdk/react/hooks', () => ({
  useEntity: () => ({ data: null }),
  usePrimaryContentReady: () => false,
  useCloudStatus: () => ({
    login: { status: h.cloudStatus, user: null },
    connection: { status: 'idle' },
    cloudUrl: '',
  }),
}));
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return {
    ...actual,
    cloudManager: { login: h.login, logout: vi.fn() },
    lmKeysService: { list: () => Promise.resolve([]) },
    capabilityManager: {
      getSnapshot: () => ({
        capability: {
          kind: 'x',
          login_state: h.loginState,
          auth_mode: 'device',
          authStatus: () => Promise.resolve(null),
        },
        checked: true,
        available: h.available,
        resolvedKind: h.resolvedKind,
      }),
      ensureChecked: () =>
        Promise.resolve({ capability: null, checked: true, available: h.available, resolvedKind: h.resolvedKind }),
      subscribe: () => () => {},
      // Behaves like the real manager: a successful set moves `resolvedKind`, which is what
      // `makeDefault` re-reads to confirm the change landed. A mock that always answered the
      // old value would fight the code rather than test it.
      setReferenceKind: (_kind: string, value: string) => {
        h.resolvedKind = value;
        return h.setReferenceKind(_kind, value);
      },
    },
  };
});

import { HarnessLoginModalRoot } from '@src/components/harness-login/HarnessLoginModal';
import { openHarnessLoginModal } from '@src/components/harness-login/harness-login-store';

function mount() {
  openHarnessLoginModal();
  render(<HarnessLoginModalRoot />);
}

describe('Assistants & keys — one row per thing that can pay', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    h.resolvedKind = 'harness.claude.cli';
    h.available = true;
    h.loginState = null;
    h.cloudStatus = 'logged_out';
  });

  it('marks the default assistant, and moves the mark when another is chosen', async () => {
    mount();

    const claude = await screen.findByTestId('harness-row-claude-default');
    const codex = await screen.findByTestId('harness-row-codex-default');
    // The tick IS the only signal of which is default — the dropdown it replaced is gone — so
    // it has to be readable by something other than colour.
    expect(claude.getAttribute('aria-pressed')).toBe('true');
    expect(codex.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(codex);

    await waitFor(() =>
      expect(screen.getByTestId('harness-row-codex-default').getAttribute('aria-pressed')).toBe('true'),
    );
    // ...and the old one lets go. A second green tick would say the box has two defaults,
    // which is not a state the backend has.
    expect(screen.getByTestId('harness-row-claude-default').getAttribute('aria-pressed')).toBe('false');
    expect(h.setReferenceKind).toHaveBeenCalledWith('harness', 'harness.codex.cli');
  });

  it('puts the mark back if the backend refuses the change', async () => {
    h.setReferenceKind.mockImplementationOnce(() => {
      h.resolvedKind = 'harness.claude.cli'; // the backend kept the old value
      return Promise.reject(new Error('nope'));
    });
    mount();

    fireEvent.click(await screen.findByTestId('harness-row-codex-default'));

    // Optimistic is fine; lying is not. The tick is the whole feedback, so it must not keep
    // claiming a change the backend threw away.
    await waitFor(() =>
      expect(screen.getByTestId('harness-row-claude-default').getAttribute('aria-pressed')).toBe('true'),
    );
    expect(screen.getByTestId('harness-row-codex-default').getAttribute('aria-pressed')).toBe('false');
  });

  it('never says "Not installed" in the list', async () => {
    h.available = false; // nothing installed at all
    mount();

    await screen.findByTestId('harness-row-claude');
    // The list answers "what pays for your calls". Whether a vendor's CLI happens to be on
    // this machine is a different question, and it made four of five rows report a fact about
    // the filesystem. It still appears INSIDE the row's own panel, where it is actionable.
    expect(screen.queryByText('Not installed')).toBeNull();
  });

  it('offers a login only where there is something to log in to', async () => {
    mount();

    await screen.findByTestId('harness-row-claude');
    // OpenCode is a client that spends a key; it has no account. Offering "Login" there is a
    // promise the row cannot keep.
    expect(screen.getByTestId('harness-row-claude-action').textContent).toContain('Login');
    expect(screen.getByTestId('harness-row-opencode-action').textContent).toBe('API key');
  });

  it('reports a key-only assistant in key words, not login words', async () => {
    mount();

    await screen.findByTestId('harness-row-opencode');
    // No key is configured in this fixture, so the honest state is "Key not set" — NOT
    // "Not signed in", which names a state OpenCode can never leave.
    expect(screen.getByTestId('harness-row-opencode-status').textContent).toContain('Key not set');
  });

  it('shows the key store as its own row, reporting whether a key exists', async () => {
    mount();

    const row = await screen.findByTestId('row-llm-keys-status');
    expect(row.textContent).toContain('Key not set');
    // "API key", not "Manage" — every button in this list names the credential it takes you
    // to set, rather than what it does to it.
    expect(screen.getByTestId('row-llm-keys-action').textContent).toContain('API key');
  });

  it('lets FlowPad be signed in to, and never offers to sign out from here', async () => {
    mount();

    const action = await screen.findByTestId('harness-row-flowpad-action');
    expect(action.textContent).toContain('Sign in');
    // Signing OUT of FlowPad affects sharing, backup and the hub socket — far beyond funding.
    // Beside four "Login/API key" buttons it would read as a funding toggle.
    expect(action.textContent).not.toContain('Sign out');

    fireEvent.click(action);
    await waitFor(() => expect(h.login).toHaveBeenCalled());
  });

  it('says FlowPad is signed in once it is, without offering the login again', async () => {
    h.cloudStatus = 'logged_in';
    mount();

    const action = await screen.findByTestId('harness-row-flowpad-action');
    expect(action.textContent).toContain('Signed in');
    expect(screen.getByTestId('harness-row-flowpad-status').textContent).toContain('Signed in');
  });

  it('keeps the panel you opened when the dialog is re-opened underneath you', async () => {
    mount();

    fireEvent.click(await screen.findByTestId('harness-row-codex-action'));
    await screen.findByTestId('harness-authmode-toggle');

    // `LlmSetupView` opens this modal from a mount effect, so anything that re-mounts it calls
    // open() again. That used to reset `selected` to null: the click selected a harness and the
    // next re-open silently threw it away, so the button appeared to do nothing at all with no
    // error anywhere. A redundant open() must never discard where the user navigated to.
    openHarnessLoginModal();

    await waitFor(() => expect(screen.queryByTestId('harness-authmode-toggle')).not.toBeNull());
  });
});
