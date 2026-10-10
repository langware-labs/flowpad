/**
 * The harness's own refusal is the backend's fact, and the modal must render it
 * straight off the status record — never from a copy of its own.
 *
 * `flow_sdk/builtin/capability.py` owns the refusal (`login_denied`): set on
 * `report-signed-out`, retracted when a login completes, a verified probe lands
 * or an explicit Test runs. The status layer (`flow_sdk/core/status`) folds it
 * into the harness's `login` — a standing refusal reads `signed_out` with the
 * harness's sentence as `login_message`, whatever an older `login_state` said —
 * and every change pushes `status_changed_msg`.
 *
 * The frontend used to keep a second copy in the harness-login store, written
 * when the modal opened and cleared only when it closed. Nothing could expire
 * it, so the backend would retract the refusal, broadcast the retraction, and
 * the modal — rendering from the duplicate — kept showing "Not signed in" over
 * a harness that had just signed in.
 *
 * Entry is the real path throughout: the real `useHarnessLoginOnAuthError` opens
 * the modal off the worker's own status detail, and every change arrives as a
 * real `status_changed_msg` through `ConnectionManager.onMessage`, which makes
 * the real Status asset re-read the record. The ONE stand-in is the HTTP
 * transport (`apiClient`), serving backend-shaped answers: jsdom has no server.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilityManager, CapabilityKinds, ConnectionManager } from '@sdk';
import apiClient from '@sdk/client';
import { useHarnessLoginStore } from '@src/components/harness-login/harness-login-store';
import { useHarnessLoginOnAuthError } from '@src/components/harness-login/use-harness-login-on-auth-error';
import { HarnessLoginModalRoot } from '@src/components/harness-login/HarnessLoginModal';
import { HarnessSignInDialogRoot } from '@src/components/harness-login/HarnessSignInDialog';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const CLAUDE = CapabilityKinds.ClaudeCode;
const CLAUDE_ID = '6f1a4f2e-8c5d-4c2b-9f77-2a0f5c9d3e11';
const DENIAL = 'Not logged in · Please run /login';

/** A `capability` row as the backend serializes it — the sign-in flow's own data lives here. */
const claudeRow = () => ({
  type: 'capability',
  id: CLAUDE_ID,
  name: 'Claude Code',
  kind: CLAUDE,
  state: 'ready',
  auth_mode: 'device',
  last_check: { available: true, message: '' },
});

/** The status record for an installed Claude with the given login. */
const record = (login: string, message = '') => ({
  harnesses: [
    {
      kind: CLAUDE,
      worker_type: 'claude',
      label: 'Claude Code',
      icon: '',
      install: 'installed',
      version: '2.1.0',
      path: '/usr/local/bin/claude',
      login,
      login_checked_at: '2026-10-03T10:00:00Z',
      login_message: message,
      account: { identity: '', plan: '' },
      has_device_login: true,
      key_providers: ['openrouter'],
      install_command: '',
      homepage_url: '',
    },
  ],
  keys: [],
  hub: { login: 'signed_out', email: '', user_typeid: '', error: '' },
  default_harness: CLAUDE,
});

/** What the backend currently answers for the status record. */
let current = record('signed_in');

/** Mounts the real auth-error hook, so the modal opens the way it does in the
 *  product: off the worker's own "Not logged in" status detail. */
function ProcessStatus({ detail }: { detail: string | null }) {
  useHarnessLoginOnAuthError(detail, 'claude');
  return null;
}

/** The backend's state changes, and it says so the way it does: one `status_changed_msg`. */
function backendNow(next: ReturnType<typeof record>) {
  current = next;
  ConnectionManager.getInstance().onMessage({
    message_type: 'status_changed_msg',
    message_id: crypto.randomUUID(),
  } as never);
}

/** The refusal recorded, as `report-signed-out` leaves the record. */
const denied = () => record('signed_out', DENIAL);
/** The retraction, as a completed login / verified probe / Test leaves it. */
const retracted = () => record('signed_in', 'claude CLI has stored credentials.');

/** The row's own button: on a signed-out row it reads "Sign in" and opens the sign-in dialog. */
async function openClaudeDetail(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(useHarnessLoginStore.getState().open).toBe(true));
  await user.click(await screen.findByTestId('harness-row-claude-action'));
}

/** The modal and the sign-in dialog, mounted the way `App` mounts them. */
function Roots() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <HarnessLoginModalRoot />
      <HarnessSignInDialogRoot />
    </QueryClientProvider>
  );
}

describe('harness login — the refusal is read from the backend, not copied', () => {
  beforeEach(async () => {
    vi.spyOn(apiClient, 'get').mockImplementation((path: string) => {
      if (path === '/graph/capability') return Promise.resolve([claudeRow()]) as never;
      if (path.endsWith('/@local/status')) return Promise.resolve(current) as never;
      // The LLM-keys list — a real backend answers with an array; none configured.
      if (path.endsWith('/lm_keys')) return Promise.resolve([]) as never;
      return Promise.resolve(null) as never;
    });
    current = record('signed_in');
    // `status/refresh` answers with the record, unchanged.
    vi.spyOn(apiClient, 'post').mockImplementation(() => Promise.resolve(current) as never);
    // The startup gate has already been seen and dismissed — the normal state
    // for a user who has been using the app. This modal is opened by the
    // harness's refusal, not by the gate.
    localStorage.setItem('llm-setup-modal-seen', 'true');
    await capabilityManager.load(true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useHarnessLoginStore.setState({ open: false });
    localStorage.clear();
  });

  it('lifts the refusal when the backend retracts it, and Done dismisses everything', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ProcessStatus detail={DENIAL} />
        <Roots />
      </MemoryRouter>,
    );

    // The worker's refusal reaches the backend, which records and broadcasts it.
    backendNow(denied());
    await openClaudeDetail(user);
    const reason = await screen.findByTestId('harness-status-reason');
    // Our words, not the vendor's: "Please run /login" is an instruction for a
    // terminal user and contradicts the sign-in button right below it.
    expect(reason.textContent).toContain("isn't signed in on this machine");
    expect(reason.textContent).not.toContain('/login');
    // The harness's own sentence survives as evidence, on the title.
    expect(reason.getAttribute('title')).toBe(DENIAL);

    // The user signs in — in the browser tab we opened, or in their own terminal
    // (`claude /login`). Either way the backend retracts the refusal and says so.
    backendNow(retracted());

    // The modal follows it.
    await waitFor(() => {
      expect(screen.getByText("You're signed in and ready to go.")).toBeTruthy();
    });
    expect(screen.queryByTestId('harness-status-reason')).toBeNull();

    // Done dismisses the dialog AND the modal under it — not one level up into the
    // assistants list, which just reads as a second popup opening by itself.
    await user.click(screen.getByTestId('harness-done'));
    await waitFor(() => expect(useHarnessLoginStore.getState().open).toBe(false));
    expect(screen.queryByText('Assistants & keys')).toBeNull();
  });

  it('a capability re-list carries no opinion to overwrite it', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ProcessStatus detail={DENIAL} />
        <Roots />
      </MemoryRouter>,
    );

    backendNow(denied());
    await openClaudeDetail(user);
    expect((await screen.findByTestId('harness-status-reason')).textContent).toContain(
      "isn't signed in on this machine",
    );

    // Re-listing capabilities is not a rare event: the Default-assistant tick and the
    // Device-login/LLM-key toggle in THIS modal both run it. Only the backend retracts a
    // refusal, and it says so with a push.
    await capabilityManager.load(true);
    expect((await screen.findByTestId('harness-status-reason')).textContent).toContain(
      "isn't signed in on this machine",
    );
    expect(screen.queryByText("You're signed in and ready to go.")).toBeNull();
  });
});
