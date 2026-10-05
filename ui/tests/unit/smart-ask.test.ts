/**
 * `smartAskOrOpen`: signed out, the session's first magic-line request asks whether to sign in;
 * every path then runs the request as normal (`askOrOpen`). "Don't ask again" is the
 * SMART_NAVIGATION_SIGNIN preference set to `skip`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'preferences.notifications.smart_navigation_signin';
const state = vi.hoisted(() => ({ loggedIn: false, local: false, hubOnly: false, prefs: {} as Record<string, unknown> }));
const login = vi.hoisted(() => vi.fn(async () => undefined));
const prefSet = vi.hoisted(() => vi.fn((k: string, v: unknown) => void (state.prefs[k] = v)));
const askOrOpen = vi.hoisted(() => vi.fn(async () => 'asked' as const));
const askNotification = vi.hoisted(() => vi.fn());

vi.mock('@sdk', () => ({
  cloudManager: {
    get isLoggedIn() {
      return state.loggedIn;
    },
    login,
  },
  privacyManager: {
    get isLocal() {
      return state.local;
    },
  },
  isHubOnly: () => state.hubOnly,
  PrefKey: { SMART_NAVIGATION_SIGNIN: 'preferences.notifications.smart_navigation_signin' },
  instancePreferences: {
    isLoaded: true,
    loadJson: vi.fn(),
    get: (k: string) => state.prefs[k] ?? 'ask',
    set: prefSet,
  },
}));
vi.mock('@src/navigation/navigation-decision', () => ({ askOrOpen }));
vi.mock('@src/notifications', () => ({ askNotification }));

const { smartAskOrOpen, __resetSmartAskForTests } = await import('@src/navigation/smart-ask');

const handlers = { open: vi.fn(), ask: vi.fn() };
const answer = (value: string | null, remember = false) => askNotification.mockResolvedValueOnce({ value, remember });

describe('smartAskOrOpen', () => {
  beforeEach(() => {
    Object.assign(state, { loggedIn: false, local: false, hubOnly: false, prefs: {} });
    vi.clearAllMocks();
    __resetSmartAskForTests();
  });

  it('signed in: runs the request with no question', async () => {
    state.loggedIn = true;
    await smartAskOrOpen('open data sources', handlers);
    expect(askNotification).not.toHaveBeenCalled();
    expect(askOrOpen).toHaveBeenCalledWith('open data sources', handlers);
  });

  it.each([
    ['Local privacy mode', () => (state.local = true)],
    ['a hub-only page', () => (state.hubOnly = true)],
    ['"Don\'t ask" in preferences', () => (state.prefs[KEY] = 'skip')],
  ])('signed out but %s: no question', async (_why, arrange) => {
    arrange();
    await smartAskOrOpen('open data sources', handlers);
    expect(askNotification).not.toHaveBeenCalled();
    expect(askOrOpen).toHaveBeenCalledTimes(1);
  });

  it('holds the request until answered; Continue runs it and remembers nothing', async () => {
    answer('continue');
    await smartAskOrOpen('open data sources', handlers);
    expect(askNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Smart navigation requires sign-in',
        remember: expect.anything(),
        location: 'center',
      }),
    );
    expect(login).not.toHaveBeenCalled();
    expect(prefSet).not.toHaveBeenCalled();
    expect(askOrOpen).toHaveBeenCalledWith('open data sources', handlers);
  });

  it('asks once per session', async () => {
    answer('continue');
    await smartAskOrOpen('one', handlers);
    await smartAskOrOpen('two', handlers);
    expect(askNotification).toHaveBeenCalledTimes(1);
    expect(askOrOpen).toHaveBeenCalledTimes(2);
  });

  it('Continue with the box ticked: preference becomes skip', async () => {
    answer('continue', true);
    await smartAskOrOpen('open data sources', handlers);
    expect(prefSet).toHaveBeenCalledWith(KEY, 'skip');
  });

  it('Log in: signs in, then runs the request', async () => {
    answer('login');
    await smartAskOrOpen('open data sources', handlers);
    expect(login).toHaveBeenCalledTimes(1);
    expect(login.mock.invocationCallOrder[0]).toBeLessThan(askOrOpen.mock.invocationCallOrder[0]);
    expect(prefSet).not.toHaveBeenCalled();
  });

  it('Log in with the box ticked: signs in AND never asks again', async () => {
    answer('login', true);
    await smartAskOrOpen('open data sources', handlers);
    expect(login).toHaveBeenCalledTimes(1);
    expect(prefSet).toHaveBeenCalledWith(KEY, 'skip');
  });

  it('a cancelled sign-in still runs the request', async () => {
    answer('login');
    login.mockRejectedValueOnce(new Error('Sign-in cancelled'));
    await smartAskOrOpen('open data sources', handlers);
    expect(askOrOpen).toHaveBeenCalledWith('open data sources', handlers);
  });

  it('closed with × (no answer): runs the request, remembers nothing', async () => {
    answer(null);
    await smartAskOrOpen('open data sources', handlers);
    expect(login).not.toHaveBeenCalled();
    expect(prefSet).not.toHaveBeenCalled();
    expect(askOrOpen).toHaveBeenCalledTimes(1);
  });
});
