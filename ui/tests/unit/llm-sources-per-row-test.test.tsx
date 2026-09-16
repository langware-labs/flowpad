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
  select: vi.fn(),
  openLogin: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
  success: vi.fn(),
  warning: vi.fn(),
  status: vi.fn(),
}));

vi.mock('@src/notifications', () => ({
  notify: { success: h.success, warning: h.warning, error: vi.fn() },
}));
vi.mock('@sdk/react/hooks', () => ({ useContext: () => ({ project: null }) }));
vi.mock('@src/components/harness-login/harness-login-store', () => ({ openHarnessLoginModal: h.openLogin }));
vi.mock('@sdk/react/hooks/useLazyAsset', () => ({ useLazyAsset: () => ({ data: h.status(), isLoading: false }) }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: {}, currentDock: null }),
}));
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return {
    ...actual,
    capabilityManager: { getSnapshot: () => ({ capability: null }), subscribe: h.subscribe },
    llmSourcesService: { testSource: h.testSource, select: h.select },
  };
});

import { LlmSourcesView } from '@src/components/llm-sources/LlmSourcesView';

const CLAUDE = 'harness.claude.cli';
const HARNESS = ['harness.claude.cli', 'harness.codex.cli', 'harness.copilot.cli', 'harness.opencode.cli'];
const DEVICE_ID = 'llm_endpoint@device';
const KEY_ID = 'llm_endpoint@key';
const HUB_ID = 'llm_endpoint@hub';

/** A funding picture with one row of each kind — the shape the page really renders. */
function funding({ deviceEligible = true }: { deviceEligible?: boolean } = {}) {
  return {
    sources: {
      [CLAUDE]: [
        {
          endpoint_typeid: DEVICE_ID,
          name: 'claude device login',
          rank: 0,
          eligible: deviceEligible,
          auto: true,
          detail: 'signed in',
        },
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

describe('choosing a device login proves it first', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    h.status.mockReturnValue(funding());
    h.select.mockResolvedValue({
      ...funding(),
      resolved: { [CLAUDE]: { endpoint_typeid: DEVICE_ID, name: 'claude device login' } },
    });
  });

  it('does not write the pick when the login turns out to be signed out', async () => {
    // The reported dead end. An UNPROBED login is `rank=30, auto=false` while a wallet is
    // available, so the hub keeps winning — and writing `auth_mode='device'` says nothing,
    // because that value reads as "no preference". The pick would evaporate silently and the
    // next terminal would still spend the budget, which is exactly what happened.
    h.testSource.mockResolvedValue({
      ok: false,
      status: 401,
      model: '',
      latency_ms: 5,
      message: 'claude is signed out',
    });

    renderPage();
    screen.getByTestId('llm-source-use-claude-device').click();

    await waitFor(() => expect(h.testSource).toHaveBeenCalledWith(expect.objectContaining({ kind: 'device' })));
    // The sign-in the row could not open — the user had signed out of the CLI outside Flowpad
    // while this page still offered Use.
    await waitFor(() => expect(h.openLogin).toHaveBeenCalled());
    expect(h.select).not.toHaveBeenCalled();
  });

  it('writes the pick once the login answers for itself', async () => {
    // A probed login is `_RANK_DEVICE` (0) and wins the ladder on merit — which is what
    // "use my OAuth" has to mean, since the preference field cannot express it.
    h.testSource.mockResolvedValue({ ok: true, status: 200, model: '', latency_ms: 5, message: '' });

    renderPage();
    screen.getByTestId('llm-source-use-claude-device').click();

    await waitFor(() => expect(h.select).toHaveBeenCalled());
    expect(h.openLogin).not.toHaveBeenCalled();
  });

  it('does not probe a key row — only a device login needs proving', async () => {
    // The hub row is the one in use here, so its button is correctly disabled; the key row is
    // the choosable non-device one.
    renderPage();
    screen.getByTestId('llm-source-use-claude-api_key').click();

    await waitFor(() => expect(h.select).toHaveBeenCalled());
    // The arrival probe fires device checks on mount; what must not happen is a KEY probe,
    // which is the one that spends.
    expect(h.testSource).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'api_key' }));
  });
});

describe('the verdict is visible on the row', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    h.status.mockReturnValue(funding());
  });

  it('states a failure on the row, not only in a toast', async () => {
    // Reported: "just a spinner on the button and then the button appears again". A test whose
    // answer you cannot find has not answered.
    h.testSource.mockResolvedValue({
      ok: false,
      status: 401,
      model: '',
      latency_ms: 4,
      message: 'claude is signed out',
    });

    renderPage();
    screen.getByTestId('llm-source-test-claude-device-claude').click();

    const verdict = await screen.findByTestId('llm-source-verdict-claude-device');
    expect(verdict.textContent).toContain('claude is signed out');
  });

  it('says so on the row when it passes too', async () => {
    h.testSource.mockResolvedValue({ ok: true, status: 200, model: 'm', latency_ms: 4, message: '' });

    renderPage();
    screen.getByTestId('llm-source-test-claude-hub-openrouter').click();

    const verdict = await screen.findByTestId('llm-source-verdict-claude-hub');
    expect(verdict.textContent).toContain('Test passed');
  });
});

describe('a failed verdict does not sit above a stale "signed in"', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    h.status.mockReturnValue(funding());
  });

  it('drops the softer standing line once the row has failed its own test', async () => {
    // Reported with a screenshot: the row read "claude CLI is not logged in." on one line
    // and "signed in" on the next. `detail` describes the row as of the last backend read;
    // a verdict from just now is newer and more specific, and two lines that contradict each
    // other are worse than one.
    h.testSource.mockResolvedValue({
      ok: false,
      status: 401,
      model: '',
      latency_ms: 3,
      message: 'claude CLI is not logged in.',
    });

    const { container } = renderPage();
    screen.getByTestId('llm-source-test-claude-device-claude').click();

    await screen.findByTestId('llm-source-verdict-claude-device');
    expect(container.textContent).toContain('claude CLI is not logged in.');
    expect(container.textContent).not.toContain('signed in');
  });

  it('keeps it when the test passed — the two agree', async () => {
    h.testSource.mockResolvedValue({ ok: true, status: 200, model: '', latency_ms: 3, message: '' });

    const { container } = renderPage();
    screen.getByTestId('llm-source-test-claude-device-claude').click();

    await screen.findByTestId('llm-source-verdict-claude-device');
    expect(container.textContent).toContain('signed in');
  });
});

describe('the arrival probe', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    h.status.mockReturnValue(funding());
    h.testSource.mockResolvedValue({ ok: true, status: 200, model: '', latency_ms: 3, message: '' });
  });

  it('checks every device login without being asked', async () => {
    // Reported: signed out of the CLI in a terminal, came to this page, and the row still
    // claimed to be signed in until Test was pressed by hand. A vendor `auth-status` is a
    // local subprocess against a subscription the user already pays for, so it is free to run
    // on arrival — and running it is the only way the page can be right about a login that
    // ended somewhere else.
    renderPage();

    await waitFor(() => expect(h.testSource).toHaveBeenCalledWith(expect.objectContaining({ kind: 'device' })));
  });

  it('never probes a key or a hub endpoint on its own', async () => {
    // Those two SPEND on every press. Arriving at a page must not cost money.
    renderPage();

    await waitFor(() => expect(h.testSource).toHaveBeenCalled());
    expect(h.testSource).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'api_key' }));
    expect(h.testSource).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'hub' }));
  });

  it('does not force, so a refusal the harness made stands', async () => {
    // `force` drops a latched refusal. The harness saying "not logged in" mid-turn is stronger
    // evidence than `auth-status`, which proves a credential exists and never that it works —
    // so clearing that automatically is how a signed-out harness reads as signed in again.
    renderPage();

    await waitFor(() => expect(h.testSource).toHaveBeenCalled());
    for (const [arg] of h.testSource.mock.calls) expect(arg.force).toBeFalsy();
  });

  it('forces when a person presses Test — that is the button that may', async () => {
    renderPage();
    h.testSource.mockClear();

    screen.getByTestId('llm-source-test-claude-device-claude').click();

    await waitFor(() => expect(h.testSource).toHaveBeenCalledWith(expect.objectContaining({ force: true })));
  });

  it('one wedged vendor CLI does not stop the others reporting', async () => {
    // Carried over from the hook test this replaced. A per-harness catch, not one around the
    // batch: three of four harnesses are usually not installed, and a missing or hanging
    // binary is the ordinary case rather than the exception.
    h.testSource.mockImplementation((s: { harness?: string }) =>
      s.harness === HARNESS[0]
        ? Promise.reject(new Error('probe timed out'))
        : Promise.resolve({ ok: true, status: 200, model: '', latency_ms: 1, message: '' }),
    );

    renderPage();

    await waitFor(() => expect(h.testSource.mock.calls.length).toBeGreaterThan(1));
    // And the page still renders — a rejected probe is swallowed, not thrown.
    expect(screen.getByTestId('llm-sources-view')).toBeTruthy();
  });

  it('has no Re-check button left to press', () => {
    // It ran `authStatus`, which reports what FUNDS the harness — so on a signed-out row it
    // announced the hub endpoint, which is not what the button appeared to offer. The arrival
    // probe answers its case unasked, and Test answers it on demand.
    h.status.mockReturnValue(funding({ deviceEligible: false }));
    renderPage();

    expect(screen.queryByTestId('llm-source-recheck-claude')).toBeNull();
    expect(screen.getByTestId('llm-source-signin-claude')).toBeTruthy();
  });
});
