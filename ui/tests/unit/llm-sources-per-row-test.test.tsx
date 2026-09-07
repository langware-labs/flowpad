/**
 * Every source row tests ITSELF, and a sign-in is visible without a reload.
 *
 * Three reports from one Windows session:
 *
 *  - the only Test button lived on a signed-out device row and ran `authStatus`, whose
 *    answer reports WHAT FUNDS THE HARNESS. Pressed after a successful sign-in it replied
 *    "using the hub endpoint" — an answer about a different row;
 *  - a key row and a hub row had no test at all, though those are the two that can fail
 *    while looking perfect (revoked, or out of credit);
 *  - and the device row never became "Use". Its affordance comes from `source.eligible`,
 *    which the backend derives from `login_state`; the login broadcasts that on
 *    `capabilityManager` while this page renders from a separate query cache nothing told.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const h = vi.hoisted(() => ({
  testSource: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
  success: vi.fn(),
  warning: vi.fn(),
  status: vi.fn(),
}));

vi.mock('@src/notifications', () => ({
  notify: { success: h.success, warning: h.warning, error: vi.fn() },
}));
vi.mock('@sdk/react/hooks', () => ({ useContext: () => ({ project: null }) }));
vi.mock('@sdk/react/hooks/useLazyAsset', () => ({ useLazyAsset: () => ({ data: h.status(), isLoading: false }) }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: {}, currentDock: null }),
}));
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return {
    ...actual,
    capabilityManager: { getSnapshot: () => ({ capability: null }), subscribe: h.subscribe },
    llmSourcesService: { testSource: h.testSource },
  };
});

import { LlmSourcesView } from '@src/components/llm-sources/LlmSourcesView';

const CLAUDE = 'harness.claude.cli';
const DEVICE_ID = 'llm_endpoint@device';
const KEY_ID = 'llm_endpoint@key';
const HUB_ID = 'llm_endpoint@hub';

/** A funding picture with one row of each kind — the shape the page really renders. */
function funding({ deviceEligible = true }: { deviceEligible?: boolean } = {}) {
  return {
    sources: {
      [CLAUDE]: [
        { endpoint_typeid: DEVICE_ID, name: 'claude device login', rank: 0, eligible: deviceEligible, auto: true },
        { endpoint_typeid: KEY_ID, name: 'openrouter key', rank: 10, eligible: true, auto: false },
        { endpoint_typeid: HUB_ID, name: 'Gadi +20', rank: 20, eligible: true, auto: false },
      ],
    },
    resolved: { [CLAUDE]: { endpoint_typeid: HUB_ID, name: 'Gadi +20' } },
    blocked: {},
    notes: {},
    endpoints: {
      [DEVICE_ID]: { id: DEVICE_ID, kind: 'device', provider: 'claude' },
      [KEY_ID]: { id: KEY_ID, kind: 'api_key', provider: 'openrouter' },
      [HUB_ID]: { id: HUB_ID, kind: 'hub', provider: 'openrouter' },
    },
    active_for: [],
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<LlmSourcesView />, { wrapper });
}

describe('a Test button on every row', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    h.status.mockReturnValue(funding());
    h.testSource.mockResolvedValue({ ok: true, status: 200, model: 'm', latency_ms: 12, message: '' });
  });

  it('offers one on all three kinds, not just the signed-out device row', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('llm-source-test-claude-device-claude')).toBeTruthy());
    expect(screen.getByTestId('llm-source-test-claude-api_key-openrouter')).toBeTruthy();
    expect(screen.getByTestId('llm-source-test-claude-hub-openrouter')).toBeTruthy();
  });

  it('asks about the row that was pressed, not about the harness', async () => {
    // The misreported verdict: the old button ran one harness-wide probe whatever row it
    // sat on. Each press now names its own kind, which is what the backend dispatches on.
    renderPage();

    screen.getByTestId('llm-source-test-claude-api_key-openrouter').click();

    await waitFor(() =>
      expect(h.testSource).toHaveBeenCalledWith(expect.objectContaining({ kind: 'api_key', provider: 'openrouter' })),
    );
  });

  it("reports a refusal in the provider's own words", async () => {
    // "Insufficient credits" and "invalid key" are different problems with different cures.
    // A verdict this page rewrote would lose the only sentence that says which.
    h.testSource.mockResolvedValue({
      ok: false,
      status: 402,
      model: 'm',
      latency_ms: 9,
      message: 'Insufficient credits',
    });
    renderPage();

    screen.getByTestId('llm-source-test-claude-hub-openrouter').click();

    await waitFor(() =>
      expect(h.warning).toHaveBeenCalledWith(expect.objectContaining({ message: 'Insufficient credits' })),
    );
    expect(h.success).not.toHaveBeenCalled();
  });

  it('spins only the row being tested', async () => {
    // One shared `isPending` greyed out every Test on the page for one row's network call.
    let resolve!: (v: unknown) => void;
    h.testSource.mockReturnValue(new Promise((r) => (resolve = r)));
    renderPage();

    const device = screen.getByTestId('llm-source-test-claude-device-claude');
    const hub = screen.getByTestId('llm-source-test-claude-hub-openrouter');
    device.click();

    await waitFor(() => expect(device.disabled).toBe(true));
    expect(hub.disabled).toBe(false);
    resolve({ ok: true, status: 200, model: '', latency_ms: 1, message: '' });
  });
});

describe('the row follows a sign-in', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    h.status.mockReturnValue(funding({ deviceEligible: false }));
  });

  it('subscribes to capability news, so a completed login can flip Sign in to Use', () => {
    // The reported symptom: sign in, succeed, and the row still offers Test and Sign in.
    // `useRefreshLoginStates` is mount-only by design, so without this subscription the page
    // keeps the snapshot it arrived with for as long as it stays open.
    renderPage();

    expect(h.subscribe).toHaveBeenCalled();
  });

  it('shows Sign in while the login is not proven, and Use once it is', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('llm-source-signin-claude')).toBeTruthy());

    cleanup();
    h.status.mockReturnValue(funding({ deviceEligible: true }));
    renderPage();

    await waitFor(() => expect(screen.getByTestId('llm-source-use-claude-device')).toBeTruthy());
    expect(screen.queryByTestId('llm-source-signin-claude')).toBeNull();
  });
});
