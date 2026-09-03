/**
 * The harness's own refusal is the backend's fact, and the modal must render it
 * straight off the entity — never from a copy of its own.
 *
 * `flow_sdk/builtin/capability.py` owns `login_denied`, an APIField it
 * serializes and maintains completely: set on `report-signed-out` (:439, and
 * refused outright while a login is in flight), cleared when a login session
 * reaches AUTHENTICATED (:345 — "A completed login is newer and stronger
 * evidence than the refusal that prompted it"), cleared by a verified probe
 * (:485) and by an explicit Test (:522) — each followed by `notify_updated()`.
 *
 * The frontend used to keep a second copy in the harness-login store, written
 * when the modal opened and cleared only when it closed. Nothing could expire
 * it, so the backend would retract the refusal, broadcast the retraction, and
 * the modal — rendering from the duplicate — kept showing the red "Claude said:
 * Not logged in" panel over a harness that had just signed in.
 *
 * Entry is the real path throughout: the real `useHarnessLoginOnAuthError` opens
 * the modal off the worker's own status detail, and every state change arrives
 * as a real `data_op_msg` through `ConnectionManager.onMessage` — the function
 * the WebSocket calls with a decoded backend frame — so each one runs the real
 * DataManager merge, the real subscriber notify and the real `useEntity`.
 * Nothing about the modal, the store, the hooks or the entity is stubbed.
 *
 * The ONE stand-in is the HTTP transport (`apiClient`), serving the
 * `/graph/capability` rows and action replies a backend would: jsdom has no
 * server, and this bug is pure client-side state derivation, so the transport is
 * the boundary the harness has to supply. Every byte it serves is backend-shaped.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilityManager, CapabilityKinds, ConnectionManager, dataManager, TypeId } from '@sdk';
import apiClient from '@sdk/client';
import { useHarnessLoginStore } from '@src/components/harness-login/harness-login-store';
import { useHarnessLoginOnAuthError } from '@src/components/harness-login/use-harness-login-on-auth-error';
import { HarnessLoginModalRoot } from '@src/components/harness-login/HarnessLoginModal';

const CLAUDE = CapabilityKinds.ClaudeCode;
const CLAUDE_ID = '6f1a4f2e-8c5d-4c2b-9f77-2a0f5c9d3e11';
const DENIAL = 'Not logged in · Please run /login';

/** A `capability` row exactly as the backend serializes it.
 *
 *  The login_* block is deliberately ABSENT: those fields are runtime-only, set
 *  in memory and broadcast but never written by `save()`, so a row rebuilt from
 *  the DB has them all None and `exclude_none` drops them. Verified against a
 *  live backend — `GET /graph/capability` returns no login_* keys at all, even
 *  immediately after `report-signed-out` recorded a refusal. That absence is
 *  what stops a refetch from overwriting a live value. */
const claudeRow = (overrides: Record<string, unknown> = {}) => ({
  type: 'capability',
  id: CLAUDE_ID,
  name: 'Claude Code',
  kind: CLAUDE,
  state: 'ready',
  auth_mode: 'device',
  last_check: { available: true, message: '' },
  ...overrides,
});

/** Mounts the real auth-error hook, so the modal opens the way it does in the
 *  product: off the worker's own "Not logged in" status detail. */
function ProcessStatus({ detail }: { detail: string | null }) {
  useHarnessLoginOnAuthError(detail, 'claude');
  return null;
}

/** Deliver a backend broadcast through the real WebSocket message handler. */
function broadcast(row: Record<string, unknown>) {
  ConnectionManager.getInstance().onMessage({
    message_type: 'data_op_msg',
    message_id: crypto.randomUUID(),
    to_entity: `capability-${CLAUDE_ID}`,
    op: 'update',
    data: row,
  } as never);
}

// The two frames below are transcribed from a live backend socket:
//   report-signed-out  → {login_state:'idle', login_message:'Not logged in · Please run /login', login_denied:true}
//   retraction         → {login_state:'authenticated', login_message:'claude CLI has stored credentials…', login_denied:false}
/** The refusal recorded and broadcast, as `report-signed-out` leaves it. */
const denied = () => claudeRow({ login_denied: true, login_message: DENIAL, login_state: 'idle' });
/** The retraction, as a completed login / verified probe / Test leaves it. */
const retracted = () =>
  claudeRow({ login_denied: false, login_state: 'authenticated', login_message: 'claude CLI has stored credentials.' });

async function openClaudeDetail(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(useHarnessLoginStore.getState().open).toBe(true));
  await user.click(await screen.findByTestId('harness-row-claude'));
}

describe('harness login — the refusal is read from the backend, not copied', () => {
  beforeEach(async () => {
    vi.spyOn(apiClient, 'get').mockImplementation((path: string) => {
      if (path === '/graph/capability') return Promise.resolve([claudeRow()]) as never;
      // The LLM-keys list — a real backend answers with an array; none configured.
      if (path.endsWith('/lm_keys')) return Promise.resolve([]) as never;
      // A presence-only probe: it finds a credential on disk and says so. The
      // backend does NOT let this retract a refusal — an unverified probe over a
      // recorded denial returns early and broadcasts nothing (capability.py:468)
      // — so the row the modal renders is unchanged by it.
      if (path.includes('auth-status')) return Promise.resolve({ status: 'logged_in', message: '' }) as never;
      return Promise.resolve(null) as never;
    });
    vi.spyOn(apiClient, 'post').mockResolvedValue(null as never);
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
        <HarnessLoginModalRoot />
      </MemoryRouter>,
    );

    // The worker's refusal reaches the backend, which records and broadcasts it.
    broadcast(denied());
    await openClaudeDetail(user);
    expect((await screen.findByTestId('harness-status-reason')).textContent).toContain(DENIAL);

    // The user signs in — in the browser tab we opened, or in their own terminal
    // (`claude /login`). Either way the backend retracts the refusal and
    // broadcasts the retraction.
    broadcast(retracted());

    // Ground truth: the retraction really landed on the client's entity, so a
    // failure below is the UI ignoring it, not a broadcast that never arrived.
    await waitFor(() => {
      const cached = dataManager.getByTypeIdFromCache(new TypeId('capability', CLAUDE_ID)) as {
        login_denied?: boolean;
        login_state?: string;
      } | null;
      expect(cached?.login_denied).toBe(false);
      expect(cached?.login_state).toBe('authenticated');
    });

    // The modal follows it.
    await waitFor(() => {
      expect(screen.getByText("You're signed in and ready to go.")).toBeTruthy();
    });
    expect(screen.queryByTestId('harness-status-reason')).toBeNull();

    // Done dismisses the modal outright — not one level up into the assistants
    // list, which just reads as a second popup opening by itself.
    await user.click(screen.getByTestId('harness-done'));
    await waitFor(() => expect(useHarnessLoginStore.getState().open).toBe(false));
    expect(screen.queryByText('Assistants & keys')).toBeNull();
  });

  it('survives a capability refetch, which carries no opinion to overwrite it', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ProcessStatus detail={DENIAL} />
        <HarnessLoginModalRoot />
      </MemoryRouter>,
    );

    broadcast(denied());
    await openClaudeDetail(user);
    expect((await screen.findByTestId('harness-status-reason')).textContent).toContain(DENIAL);

    // Re-listing capabilities is not a rare event: the Default-assistant select
    // and the Device-login/LLM-key toggle in THIS modal both run it, via
    // `mutateAndRecheck` → `load(true)`. It must not retract a refusal — only
    // the backend retracts, and it says so with a broadcast.
    await capabilityManager.load(true);
    const cached = dataManager.getByTypeIdFromCache(new TypeId('capability', CLAUDE_ID)) as {
      login_denied?: boolean;
    } | null;
    expect(cached?.login_denied).toBe(true);
    expect((await screen.findByTestId('harness-status-reason')).textContent).toContain(DENIAL);
    expect(screen.queryByText("You're signed in and ready to go.")).toBeNull();
  });

  it('lets the refusal outrank a stale authenticated login_state', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ProcessStatus detail={DENIAL} />
        <HarnessLoginModalRoot />
      </MemoryRouter>,
    );

    // The row the backend leaves when the refusal stands over a months-old
    // successful login: login_denied wins, and the modal must not read the
    // stale positive as "Signed in" — the regression 3b416670c exists to stop.
    broadcast(claudeRow({ login_denied: true, login_message: DENIAL, login_state: 'authenticated' }));
    await openClaudeDetail(user);

    expect((await screen.findByTestId('harness-status-reason')).textContent).toContain(DENIAL);
    expect(screen.queryByText("You're signed in and ready to go.")).toBeNull();
  });
});
