/**
 * The state key a window or page presents to the local server, and what to say when it is refused.
 *
 * The local server answers no API call without a key it minted (`flow_sdk/server/page_state.py`). The
 * key arrives as `globalThis.__FLOWPAD_STATE_KEY__` (the server writes it into the page, the host into
 * an MCP page) or, for a page with no injection (a dev-server app), as `?state=` in its own URL. The
 * app's own shell also keeps it in `sessionStorage` so its own script reload still has it — and ONLY the
 * top-level window does: a frame sharing that storage must not borrow the app's key.
 *
 * A refusal names its reason in `X-Flowpad-Gate: state=missing|unknown`; `showPageStateError` says it
 * inside the page, never as a toast.
 */

import { TypeId } from './models/TypeId';

const STORE = 'flowpad.stateKey';
export const STATE_HEADER = 'X-Flowpad-State';
/** The query a page's address carries its key in (the server reads the same name: `page_state.QUERY`). */
export const STATE_QUERY = 'state';
const HAS_STATE_QUERY = new RegExp(`[?&]${STATE_QUERY}=`);

type Reason = 'missing' | 'unknown';

const MESSAGES: Record<Reason, string> = {
  missing: 'This page was opened without permission to use Flowpad. Open it again from Flowpad.',
  unknown:
    "This page's access key is not valid here: it expired, or it came from another computer. Open it again from Flowpad.",
};

function isTopLevel(): boolean {
  try {
    return window.top === window;
  } catch {
    return false;
  }
}

function recall(): string | null {
  try {
    return window.sessionStorage.getItem(STORE);
  } catch {
    return null;
  }
}

function remember(key: string): void {
  try {
    window.sessionStorage.setItem(STORE, key);
  } catch {
    /* storage can be blocked: the key still works until the document reloads */
  }
}

/** The key this window or page presents, or null when it holds none. */
export function stateKey(): string | null {
  const injected = (globalThis as { __FLOWPAD_STATE_KEY__?: unknown }).__FLOWPAD_STATE_KEY__;
  if (typeof injected === 'string' && injected) {
    if (isTopLevel()) remember(injected);
    return injected;
  }
  const fromUrl = new URLSearchParams(globalThis.location?.search ?? '').get(STATE_QUERY);
  if (fromUrl) return fromUrl;
  return isTopLevel() ? recall() : null;
}

/**
 * `url` carrying a key as its `state` query — what lets a request that cannot send a header (a module `import()`,
 * a frame's address) present it. Defaults to this window's own key; a key already in the url stays; no key leaves
 * the url as it was. The fragment, if any, stays last.
 */
export function withStateKey(url: string, key: string | null | undefined = stateKey()): string {
  if (!url || !key) return url;
  const [beforeHash, ...hash] = url.split('#');
  if (HAS_STATE_QUERY.test(beforeHash)) return url;
  const joined = `${beforeHash}${beforeHash.includes('?') ? '&' : '?'}${STATE_QUERY}=${encodeURIComponent(key)}`;
  return hash.length ? `${joined}#${hash.join('#')}` : joined;
}

/** The reason a response says the key was refused, or null when it is some other answer. */
export function stateRefusal(headers: unknown): Reason | null {
  const gate = String((headers as Record<string, unknown> | undefined)?.['x-flowpad-gate'] ?? '');
  const found = /(?:^|;\s*)state=(missing|unknown)\b/.exec(gate);
  return found ? (found[1] as Reason) : null;
}

/** Say, inside the page, why it cannot use Flowpad. Idempotent: one notice per page. */
export function showPageStateError(reason: Reason): void {
  if (typeof document === 'undefined' || document.querySelector('[data-testid="flowpad-page-error"]')) return;
  const notice = document.createElement('div');
  notice.setAttribute('data-testid', 'flowpad-page-error');
  notice.setAttribute('role', 'alert');
  notice.textContent = MESSAGES[reason];
  notice.style.cssText =
    'position:fixed;inset:0 0 auto 0;z-index:2147483647;padding:12px 16px;font:14px/1.4 system-ui,sans-serif;' +
    'background:#fff3cd;color:#664d03;border-bottom:1px solid #ffda6a';
  (document.body ?? document.documentElement).prepend(notice);
}

const OFFLINE = '[data-testid="flowpad-page-offline"]';

/** Say, inside the page, that Flowpad cannot be reached: a small tag in the corner the user can close. Never blocks the page. */
export function showOfflineTag(): void {
  if (typeof document === 'undefined' || document.querySelector(OFFLINE)) return;
  const tag = document.createElement('div');
  tag.setAttribute('data-testid', 'flowpad-page-offline');
  tag.setAttribute('role', 'status');
  tag.style.cssText =
    'position:fixed;right:12px;bottom:12px;z-index:2147483647;display:flex;gap:8px;align-items:center;' +
    'padding:6px 10px;border-radius:6px;font:12px/1.4 system-ui,sans-serif;background:#fff3cd;color:#664d03;' +
    'border:1px solid #ffda6a';
  const text = document.createElement('span');
  text.textContent = "Flowpad isn't running";
  const close = document.createElement('button');
  close.setAttribute('aria-label', 'Close');
  close.textContent = '✕';
  close.style.cssText = 'border:0;background:none;color:inherit;cursor:pointer;padding:0;font:inherit';
  close.onclick = () => tag.remove();
  tag.append(text, close);
  (document.body ?? document.documentElement).append(tag);
}

/** Take the offline tag away: a call got through. */
export function hideOfflineTag(): void {
  if (typeof document !== 'undefined') document.querySelector(OFFLINE)?.remove();
}

export interface HtmlPage {
  /** What the page was opened about: named typed ids, e.g. `{ process: 'agentic_process-<id>' }`. */
  context: Record<string, string>;
  /** The session the page was opened beside, when its opener named one. */
  process: TypeId | null;
  /** False on a server that does not demand keys (the hub, a dev run): the page then has no context. */
  enforced: boolean;
}

/**
 * The one call an HTML page makes to learn what it was opened about. Reads the state its key stands for;
 * a missing or unknown key is said inside the page and rejects.
 */
export async function htmlPage(): Promise<HtmlPage> {
  const { apiClient } = await import('./client');
  const data = (await apiClient.get('/api/v1/page-state')) as {
    enforced: boolean;
    state: { context?: Record<string, string> } | null;
  };
  if (data.enforced && !data.state) {
    const reason = stateKey() ? 'unknown' : 'missing';
    showPageStateError(reason);
    throw new Error(MESSAGES[reason]);
  }
  const context = data.state?.context ?? {};
  return {
    context,
    process: context.process ? new TypeId(context.process) : null,
    enforced: data.enforced,
  };
}
