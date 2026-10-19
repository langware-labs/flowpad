/**
 * What a served app is FOR — resolved from the page's own URL, never from a
 * value written into the app.
 *
 * Every served app is served by a `ServiceEndpoint`, at
 * `/api/v1/graph/service_endpoint/<id>/service/<mount>/…`, so the page's path already names
 * what serves it: its placement's audience proxy, and its mount there. A route serving a
 * webapp ASSET names its definition (`webapp_id`); that definition is an ordinary asset, which means it has a
 * parent: the asset it is nested inside. An editor therefore learns what it edits
 * by asking who contains its app — the same containment the address bar renders
 * as `Project / rss / editor`.
 *
 * Nothing here is specific to editors. Any app that wants to act on the thing
 * it ships with reads its subject the same way.
 */
import { dataManager, type AnyEntity } from '../APIEntity';
import { TypeId } from '../models/TypeId';
import { installTooltips } from '../viewers/dom';

/** The endpoint this page is being served by, from `location.pathname`. */
export function appTypeId(pathname: string = location.pathname): TypeId | null {
  const m = pathname.match(/graph\/(service_endpoint)\/([^/]+)\/service/i);
  return m ? new TypeId(m[1], m[2]) : null;
}

/** The first path segment under the endpoint's `service` root — the page's mount, when it has one. */
export function appMount(pathname: string = location.pathname): string {
  const m = pathname.match(/graph\/service_endpoint\/[^/]+\/service\/([^/]*)/i);
  return m ? decodeURIComponent(m[1]) : '';
}

/**
 * The webapp definition a page of `endpoint` at `pathname` belongs to. On an audience proxy that
 * is the route the path lands on — its named mount, else the root app; on an endpoint of its own,
 * the endpoint's.
 */
export function servedWebappId(
  endpoint: { webapp_id?: string | null; backend?: { type?: string; routes?: Record<string, { webapp_id?: string | null }> } },
  pathname: string = location.pathname,
): string | null {
  const routes = endpoint.backend?.type === 'routed' ? (endpoint.backend.routes ?? {}) : null;
  if (!routes) return endpoint.webapp_id ?? null;
  const route = routes[appMount(pathname)] ?? routes[''];
  return route?.webapp_id ?? null;
}

export interface AppHost {
  /** The app: the webapp definition the endpoint serves, else the endpoint itself. */
  app: AnyEntity;
  /** The asset the app is nested inside — what it edits. Null at top level. */
  subject: AnyEntity | null;
}

/**
 * Resolve `{app, subject}` for the page. Throws when the page was not served by an
 * endpoint — a wrong answer here would silently edit the wrong entity.
 */
export async function resolveAppHost(): Promise<AppHost> {
  const typeId = appTypeId();
  if (!typeId) throw new Error('not served by a service endpoint');
  const endpoint = await dataManager.getByTypeId(typeId);
  if (!endpoint) throw new Error(`no ${typeId}`);
  const webappId = servedWebappId(endpoint as Parameters<typeof servedWebappId>[0]);
  const app = webappId ? await dataManager.getByTypeId(new TypeId('micro_app', webappId)) : endpoint;
  if (!app) throw new Error(`no micro_app-${webappId}`);
  // Nested: the subject is what CONTAINS the app. Matched by kind (an editor that ships on its
  // own and edits any `navigator.dataset`): the host names the subject in `?subject=<typeid>`.
  const parent = (app as any).parent_type_id ?? appOption('subject');
  const subject = parent ? await dataManager.getByTypeId(new TypeId(parent)) : null;
  return { app, subject };
}

/** Ask the host to open a dock (`{address: '/dock/...'}`) or an entity where its type lives
 *  (`{typeid}`). URL-first: the HOST navigates; an app never moves the window itself. The host
 *  honours it only from this app's own frame (`app-display-viewer.tsx`). */
export function navigateHost(target: { address: string } | { typeid: string }): void {
  postToHost({ type: 'flowpad:navigate', ...target });
}

/** Whether a host frames this page. A page opened on its own has no one to ask. */
export function hasHost(): boolean {
  return window.parent != null && window.parent !== window;
}

/** Send the host a message (`{type: 'flowpad:…', …}`). Nothing happens without a host. */
export function postToHost(message: { type: string } & Record<string, unknown>): void {
  if (hasHost()) window.parent.postMessage(message, '*');
}

/** Hear the host's messages of one `type`. Returns the function that stops listening. */
export function onHostMessage<T extends { type: string }>(type: string, handler: (data: T) => void): () => void {
  const listener = (event: MessageEvent) => {
    const data = event.data as { type?: string } | null;
    if (data?.type === type) handler(data as T);
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}

/** The message an app sends to have the host open an outside page (`openExternal`). */
export const OPEN_EXTERNAL_MESSAGE = 'flowpad:open-external';

/** `url` when it is an absolute http(s) address — the only kind that leaves the app — else null. */
export function externalUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Open an outside page (a record in a CRM, a report) in the person's browser. The HOST opens it —
 *  in the desktop app that is the system browser, which a frame's own `window.open` does not
 *  reliably reach. Only an absolute http(s) address is opened (anything else throws: a typo
 *  should not pass silently); an app shown on its own, outside Flowpad, opens a new tab itself. */
export function openExternal(url: string): void {
  const address = externalUrl(url);
  if (!address) throw new Error(`openExternal: an absolute http(s) address is required, not ${JSON.stringify(url)}`);
  if (hasHost()) postToHost({ type: OPEN_EXTERNAL_MESSAGE, url: address });
  else window.open(address, '_blank', 'noopener,noreferrer');
}

/** The host says whether this app's frame is on screen (`{type, hidden}`); the app asks with
 *  `VISIBILITY_PLEASE` when it loads, since a message sent before its listener existed is gone. */
export const VISIBILITY_MESSAGE = 'flowpad:visibility';
export const VISIBILITY_PLEASE_MESSAGE = 'flowpad:visibility-please';

let parkedByHost = false;
let visibilityAdopted = false;

/**
 * Make `document.hidden` true while the host has this app's tab parked.
 *
 * A served app keeps its frame mounted when its tab is not the one shown (so it never reloads),
 * hidden with CSS — which the browser does not count as hidden: inside the frame `document.hidden`
 * stays false and every timer, poll and focus handler keeps running, for every parked app at once.
 * So the host says when it parks and shows the frame, and this folds that into the page's own
 * visibility: `document.hidden` / `visibilityState` answer "parked OR the window is hidden", and a
 * `visibilitychange` fires on each flip. Nothing new to learn — code that already pauses when the
 * page is hidden (the right thing on its own) pauses when parked too.
 *
 * `initSdk()` installs it in a served app (one addressed by a service endpoint); a page opened on
 * its own, or in a host that does not say, keeps the browser's answer. Idempotent.
 */
export function adoptHostVisibility(): void {
  if (visibilityAdopted) return;
  visibilityAdopted = true;
  const browser = (name: 'hidden' | 'visibilityState') => Object.getOwnPropertyDescriptor(Document.prototype, name)!.get!.bind(document);
  const windowHidden = browser('hidden');
  const windowState = browser('visibilityState');
  const hidden = () => parkedByHost || windowHidden() === true;
  Object.defineProperty(document, 'hidden', { configurable: true, get: hidden });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden() ? 'hidden' : windowState()) });
  onHostMessage<{ type: string; hidden?: unknown }>(VISIBILITY_MESSAGE, (data) => {
    if (typeof data.hidden !== 'boolean') return;
    const before = hidden();
    parkedByHost = data.hidden;
    if (hidden() !== before) document.dispatchEvent(new Event('visibilitychange'));
  });
  postToHost({ type: VISIBILITY_PLEASE_MESSAGE });
}

/** Why a call failed, in words: the server's message, else the error's own. */
export function errorText(error: any): string {
  return String(error?.response?.data?.message ?? error?.message ?? error);
}

/** A query-string option the dock passed through, e.g. `?source=<id>`. */
export function appOption(name: string): string | null {
  return new URLSearchParams(location.search).get(name);
}

/**
 * Adopt the host's colour theme, from `?theme=light|dark` on this page's URL.
 *
 * A served app is cross-origin to the Flowpad window, so it cannot read the
 * `.dark` class the host writes on its own `<html>` — and `prefers-color-scheme`
 * is the OS preference, which is not the same thing as the theme the user chose
 * in the app. So the display passes it on the URL, and applying it here, before
 * first paint, is what stops a light flash inside a dark window.
 *
 * Pairs with `/sdk/flowpad.css`, which defines the palette on `:root` and
 * redefines it under `.dark`. Safe to call when neither is present: the page
 * simply stays light.
 */
export function applyHostTheme(): 'light' | 'dark' {
  // No param means nobody is hosting this page — it was opened on its own. Follow
  // the OS there rather than forcing light, so a standalone page on a dark
  // desktop does not glare.
  const param = appOption('theme');
  const prefersDark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = (param ? param === 'dark' : prefersDark) ? 'dark' : 'light';
  applyHostSkin(theme, appOption('view'), appOption('primary'), appOption('primaryInk'));
  // An app's hover help: its frame shows no native `title` tooltip in the desktop app.
  installTooltips();
  // The URL carries the skin for the FIRST paint only — it is frozen there,
  // because the host addresses this frame by its src and re-addressing it would
  // reload the whole app to recolour it. Later changes arrive as a message, and
  // recolouring is a class flip.
  onHostMessage<{ type: string; theme?: string; view?: string; primary?: string; primaryInk?: string }>('flowpad:theme', (data) =>
    applyHostSkin(data.theme === 'dark' ? 'dark' : 'light', data.view ?? null, data.primary, data.primaryInk),
  );
  // Ask the host for the current skin. The host cannot know when this document
  // finished loading, and a message sent before this listener existed is gone —
  // so the guest starts the exchange rather than hoping it was heard. With no
  // host, the URL seed and the OS preference already gave a correct first paint.
  postToHost({ type: 'flowpad:skin-please' });
  return theme;
}

/**
 * Both axes of the host's appearance at once.
 *
 * The colour scheme is a class and the view mode is an attribute — the same two
 * hooks `/sdk/flowpad.css` keys its four token blocks on, and the same ones the
 * app writes on its own `<html>`. Setting only the scheme renders the desk skin
 * inside a vibe window: squarer corners and the wrong primary colour.
 */
function applyHostSkin(
  theme: 'light' | 'dark',
  view: string | null,
  primary?: string | null,
  primaryInk?: string | null,
): void {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  if (view) root.setAttribute('data-view', view);
  // `--primary` and its ink are the two tokens the app brands at RUNTIME rather
  // than in its stylesheet (`useColorPalette` writes them inline from the site
  // config), so the generated sheet cannot carry them and a white-labelled
  // deployment would otherwise show its brand everywhere except inside its apps.
  if (primary) root.style.setProperty('--primary', primary);
  if (primaryInk) root.style.setProperty('--primary-foreground', primaryInk);
}
