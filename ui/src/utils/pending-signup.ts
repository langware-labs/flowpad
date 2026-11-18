import { trackEvent } from '@src/utils/analytics';
import { measured } from '@src/utils/google-tag-manager';

/**
 * Set while a sign-up waits for the visitor's cookie choice. Holds a timestamp and nothing else.
 * `public/auth-popup-done.html` writes the same key for a sign-up made in the popup.
 */
const PENDING_KEY = '_pending_signup';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Set once `sign_up` was sent in this tab. Survives the reload CookieScript does after a choice. */
const SENT_KEY = '_signup_sent';

const CONSENT_COOKIE = 'CookieScriptConsent';
/** The CookieScript category that grants Google's `analytics_storage`. */
const ANALYTICS_CATEGORY = 'performance';

type Consent = 'granted' | 'denied' | 'undecided';

/**
 * The visitor's choice, from CookieScript's own cookie: it is there before the banner
 * script loads, which happens after the app's first render.
 */
function readConsent(): Consent {
  const prefix = `${CONSENT_COOKIE}=`;
  const raw = document.cookie
    .split('; ')
    .find((cookie) => cookie.startsWith(prefix))
    ?.slice(prefix.length);
  if (!raw) return 'undecided';

  try {
    // `categories` is a JSON string inside the JSON. Before any choice the cookie exists with no `action`.
    const { action, categories } = JSON.parse(decodeURIComponent(raw)) as { action?: string; categories?: string };
    if (action === 'reject') return 'denied';
    if (action !== 'accept') return 'undecided';
    return (JSON.parse(categories ?? '[]') as string[]).includes(ANALYTICS_CATEGORY) ? 'granted' : 'denied';
  } catch {
    return 'undecided';
  }
}

/**
 * Send or drop a held sign-up once the visitor's choice is known. App runs this on every route,
 * and never on CookieScript's own choice event: CookieScript reloads right after a choice, which
 * can lose a hit sent then, so the choice is settled on the page that reload brings.
 */
export function settleHeldSignUp(): void {
  const heldAt = Number(localStorage.getItem(PENDING_KEY));
  if (!heldAt) return;

  const consent = readConsent();
  const expired = Date.now() - heldAt > MAX_AGE_MS;
  if (consent === 'undecided' && !expired) return;
  // Without GTM on this page the event would go nowhere, so it waits for a page that has it.
  if (consent === 'granted' && !expired && !measured(window.location.pathname, window.location.search)) return;

  if (consent === 'granted' && !expired && !sessionStorage.getItem(SENT_KEY)) {
    sessionStorage.setItem(SENT_KEY, '1');
    trackEvent({ event: 'sign_up' });
  }
  localStorage.removeItem(PENDING_KEY);
}

/** Report a sign-up now if analytics is allowed; otherwise hold it for the visitor's choice. */
export function trackSignUpWhenConsented(): void {
  localStorage.setItem(PENDING_KEY, String(Date.now()));
  settleHeldSignUp();
}
