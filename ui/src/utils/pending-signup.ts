import { trackEvent } from '@src/utils/analytics';

/** Set while a sign-up waits for the visitor's cookie choice. Holds a timestamp and nothing else. */
const PENDING_KEY = '_pending_signup';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const CONSENT_COOKIE = 'CookieScriptConsent';
/** The CookieScript category that grants Google's `analytics_storage`. */
const ANALYTICS_CATEGORY = 'performance';
/** Fires on load, accept and reject. On accept, CookieScript has already updated Google consent. */
const CONSENT_EVENT = 'CookieScriptCurrentState';

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

function settleHeldSignUp(): void {
  const heldAt = Number(localStorage.getItem(PENDING_KEY));
  if (!heldAt) return;

  const consent = readConsent();
  const expired = Date.now() - heldAt > MAX_AGE_MS;
  if (consent === 'undecided' && !expired) return;

  // Cleared first, so the event is sent once.
  localStorage.removeItem(PENDING_KEY);
  if (consent === 'granted' && !expired) trackEvent({ event: 'sign_up' });
}

/** Report a sign-up now if analytics is allowed; otherwise hold it for the visitor's choice. */
export function trackSignUpWhenConsented(): void {
  localStorage.setItem(PENDING_KEY, String(Date.now()));
  settleHeldSignUp();
}

/** Settle a sign-up held on an earlier page load, and any held later. Returns the cleanup. */
export function watchConsentForHeldSignUp(): () => void {
  settleHeldSignUp();
  document.addEventListener(CONSENT_EVENT, settleHeldSignUp);
  return () => document.removeEventListener(CONSENT_EVENT, settleHeldSignUp);
}
