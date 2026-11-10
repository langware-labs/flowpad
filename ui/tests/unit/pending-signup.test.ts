// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ trackEvent: vi.fn(), measured: vi.fn(() => true) }));
vi.mock('@src/utils/analytics', () => ({ trackEvent: mocks.trackEvent }));
vi.mock('@src/utils/google-tag-manager', () => ({ measured: mocks.measured }));

import { settleHeldSignUp, trackSignUpWhenConsented } from '@src/utils/pending-signup';

const DAY_MS = 24 * 60 * 60 * 1000;
const COOKIE = 'CookieScriptConsent';

const setConsent = (value: Record<string, unknown>): void => {
  document.cookie = `${COOKIE}=${encodeURIComponent(JSON.stringify(value))}; path=/`;
};
const accept = (categories: string[]): void => setConsent({ action: 'accept', categories: JSON.stringify(categories) });
const nextPageLoad = settleHeldSignUp;
const held = (): string | null => localStorage.getItem('_pending_signup');

describe('sign-up held until consent', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    document.cookie = `${COOKIE}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
    mocks.trackEvent.mockClear();
    mocks.measured.mockReturnValue(true);
  });

  it('sends at once when analytics is already allowed', () => {
    accept(['performance']);
    trackSignUpWhenConsented();
    expect(mocks.trackEvent).toHaveBeenCalledExactlyOnceWith({ event: 'sign_up' });
    expect(held()).toBeNull();
  });

  it('holds while there is no consent cookie', () => {
    trackSignUpWhenConsented();
    expect(mocks.trackEvent).not.toHaveBeenCalled();
    expect(held()).not.toBeNull();
  });

  it('holds while the cookie exists but no choice was made', () => {
    setConsent({ googleconsentmap: { analytics_storage: 'performance' } });
    trackSignUpWhenConsented();
    expect(mocks.trackEvent).not.toHaveBeenCalled();
    expect(held()).not.toBeNull();
  });

  it('sends nothing during the choice, which CookieScript follows with a reload', () => {
    trackSignUpWhenConsented();
    accept(['performance']);
    document.dispatchEvent(new CustomEvent('CookieScriptCurrentState'));
    expect(mocks.trackEvent).not.toHaveBeenCalled();
    expect(held()).not.toBeNull();
  });

  it('sends once on the page load after the visitor accepts', () => {
    trackSignUpWhenConsented();
    accept(['performance', 'targeting']);
    nextPageLoad();
    nextPageLoad();
    expect(mocks.trackEvent).toHaveBeenCalledExactlyOnceWith({ event: 'sign_up' });
    expect(held()).toBeNull();
  });

  it('holds on a page without GTM even when allowed, and sends where GTM loads', () => {
    accept(['performance']);
    mocks.measured.mockReturnValue(false);
    trackSignUpWhenConsented();
    expect(mocks.trackEvent).not.toHaveBeenCalled();
    expect(held()).not.toBeNull();

    mocks.measured.mockReturnValue(true);
    nextPageLoad();
    expect(mocks.trackEvent).toHaveBeenCalledExactlyOnceWith({ event: 'sign_up' });
    expect(held()).toBeNull();
  });

  it('marks the event sent before firing it', () => {
    let markedAtSend: string | null = null;
    mocks.trackEvent.mockImplementationOnce(() => {
      markedAtSend = sessionStorage.getItem('_signup_sent');
    });
    accept(['performance']);
    trackSignUpWhenConsented();
    expect(markedAtSend).toBe('1');
  });

  it('does not send twice in one tab session, even if held again', () => {
    accept(['performance']);
    trackSignUpWhenConsented();
    trackSignUpWhenConsented();
    expect(mocks.trackEvent).toHaveBeenCalledExactlyOnceWith({ event: 'sign_up' });
    expect(held()).toBeNull();
  });

  it('drops the event when the visitor rejects', () => {
    trackSignUpWhenConsented();
    setConsent({ action: 'reject', categories: '[]' });
    nextPageLoad();
    expect(mocks.trackEvent).not.toHaveBeenCalled();
    expect(held()).toBeNull();
  });

  it('drops the event when the visitor accepts everything but analytics', () => {
    trackSignUpWhenConsented();
    accept(['functionality']);
    nextPageLoad();
    expect(mocks.trackEvent).not.toHaveBeenCalled();
    expect(held()).toBeNull();
  });

  it.each([
    ['undecided', () => undefined],
    ['accepted', () => accept(['performance'])],
  ])('drops the event after 7 days when %s', (_name, decide) => {
    localStorage.setItem('_pending_signup', String(Date.now() - 8 * DAY_MS));
    decide();
    nextPageLoad();
    expect(mocks.trackEvent).not.toHaveBeenCalled();
    expect(held()).toBeNull();
  });

  it('keeps holding at 6 days', () => {
    localStorage.setItem('_pending_signup', String(Date.now() - 6 * DAY_MS));
    nextPageLoad();
    expect(held()).not.toBeNull();
  });

  it('holds when the cookie is unreadable', () => {
    document.cookie = `${COOKIE}=%E0%A4%A; path=/`;
    trackSignUpWhenConsented();
    expect(mocks.trackEvent).not.toHaveBeenCalled();
    expect(held()).not.toBeNull();
  });

  describe('sign-up made in the popup', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const runPopupPage = (search: string): void => {
      const html = readFileSync(resolve(process.cwd(), 'public/auth-popup-done.html'), 'utf8');
      const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
      window.history.pushState({}, '', `/auth-popup-done.html${search}`);
      vi.spyOn(window, 'close').mockImplementation(() => undefined);
      // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the static page's own inline script
      new Function(script)();
    };

    it('is held under the key the app settles', () => {
      runPopupPage('?next=%2Flaunch&signup');
      expect(held()).not.toBeNull();

      accept(['performance']);
      nextPageLoad();
      expect(mocks.trackEvent).toHaveBeenCalledExactlyOnceWith({ event: 'sign_up' });
    });

    it('holds nothing for a login', () => {
      runPopupPage('?next=%2Flaunch&login');
      expect(held()).toBeNull();
    });
  });
});
