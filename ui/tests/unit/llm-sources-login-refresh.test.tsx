/**
 * The LLM Sources page re-asks each harness whether it is signed in, on arrival.
 *
 * `Capability.login_state` is runtime-only and resolved in exactly two places:
 * the backend's startup sweep, and the Assistants & keys modal's probe when it
 * opens. Nothing else refreshes it. So someone who signs in to the vendor CLI
 * outside Flowpad leaves this page reporting "signed out" until the backend
 * restarts — and the device source it would otherwise pick stays ineligible.
 *
 * That is a LOOP, not just a stale label: a launch with no usable source now
 * routes here, and a page that cannot learn the truth hands the user straight
 * back to the failure that sent them. Reported on Windows exactly that way —
 * signed in to Claude, verified outside Flowpad, and every attempt to open a
 * session landed back on this page.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const h = vi.hoisted(() => ({
  authStatus: vi.fn(),
  capabilityFor: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('@src/notifications', () => ({
  notify: { success: h.success, warning: h.warning, error: vi.fn() },
}));

vi.mock('@sdk/react/hooks', () => ({ useContext: () => ({ project: null }) }));
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return {
    ...actual,
    capabilityManager: { getSnapshot: (kind: string) => ({ capability: h.capabilityFor(kind) }) },
  };
});

import { HARNESS_CAPABILITY_KINDS } from '@sdk';
import { useRecheckSignIn, useRefreshLoginStates } from '@src/components/llm-sources/use-llm-sources';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('LLM sources arrival login re-probe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.authStatus.mockResolvedValue({ status: 'logged_in' });
    h.capabilityFor.mockImplementation(() => ({ authStatus: h.authStatus }));
  });

  it('asks every harness, so a sign-in made elsewhere is seen', async () => {
    renderHook(() => useRefreshLoginStates(), { wrapper });

    await waitFor(() => expect(h.authStatus).toHaveBeenCalledTimes(HARNESS_CAPABILITY_KINDS.length));
  });

  it('one hanging vendor CLI does not stop the others reporting', async () => {
    // Per-harness catch, not one around the batch. A missing or wedged binary is
    // ordinary — three of four harnesses are usually not installed.
    h.capabilityFor.mockImplementation((kind: string) =>
      kind === HARNESS_CAPABILITY_KINDS[0]
        ? { authStatus: () => Promise.reject(new Error('probe timed out')) }
        : { authStatus: h.authStatus },
    );

    renderHook(() => useRefreshLoginStates(), { wrapper });

    await waitFor(() => expect(h.authStatus).toHaveBeenCalledTimes(HARNESS_CAPABILITY_KINDS.length - 1));
  });

  it('survives a harness with no capability row at all', async () => {
    h.capabilityFor.mockReturnValue(null);

    renderHook(() => useRefreshLoginStates(), { wrapper });

    // Nothing to ask and nothing thrown — the page still renders what it has.
    await waitFor(() => expect(h.capabilityFor).toHaveBeenCalled());
    expect(h.authStatus).not.toHaveBeenCalled();
  });
});

/**
 * The forced re-check — "I signed in elsewhere, look again".
 *
 * A refusal the harness made mid-turn is LATCHED, and the silent probe above
 * may not clear it: `claude auth status` reports a credential's presence, never
 * its validity, so presence must not overturn a refusal the harness actually
 * made. `force` is the user asserting they fixed it, which is why it belongs on
 * a button and not on a render.
 *
 * Reported exactly that way: signed in with `claude /login` outside Flowpad,
 * and the row kept saying "signed out" while offering only a Sign in button for
 * a login already completed.
 */
describe('LLM sources forced re-check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.capabilityFor.mockImplementation(() => ({ authStatus: h.authStatus }));
  });

  it('asks with force, which is the only probe that may clear a latched refusal', async () => {
    h.authStatus.mockResolvedValue({ status: 'logged_in', message: 'stored credentials' });

    const { result } = renderHook(() => useRecheckSignIn(), { wrapper });
    result.current.mutate('harness.claude.cli');

    await waitFor(() => expect(h.authStatus).toHaveBeenCalledWith(true));
    await waitFor(() => expect(h.success).toHaveBeenCalled());
  });

  it('says so when the harness really is still signed out', async () => {
    // Forcing is not asserting the answer — a genuine sign-out still reports as
    // one, and the latch is cleared to whatever the probe actually found.
    h.authStatus.mockResolvedValue({ status: 'logged_out', message: 'please run /login' });

    const { result } = renderHook(() => useRecheckSignIn(), { wrapper });
    result.current.mutate('harness.claude.cli');

    await waitFor(() => expect(h.warning).toHaveBeenCalled());
    expect(h.success).not.toHaveBeenCalled();
  });
});
