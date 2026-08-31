/**
 * What a served app is FOR — resolved from the page's own URL, never from a
 * value written into the app.
 *
 * A webapp asset is served at `/api/v1/graph/micro_app/<id>/view/…`, so the
 * page's path already names its own delivery row. That row is an ordinary
 * asset, which means it has a parent: the asset it is nested inside. An editor
 * therefore learns what it edits by asking who contains it — the same
 * containment the address bar renders as `Project / rss / editor`.
 *
 * Nothing here is specific to editors. Any app that wants to act on the thing
 * it ships with reads its subject the same way.
 */
import { APIEntity, dataManager, type AnyEntity } from '../APIEntity';
import { TypeId } from '../models/TypeId';

/** The `micro_app` this page is being served as, from `location.pathname`. */
export function appTypeId(pathname: string = location.pathname): TypeId | null {
  const m = pathname.match(/graph\/(micro_app)\/([^/]+)\/view/i);
  return m ? new TypeId(m[1], m[2]) : null;
}

export interface AppHost {
  /** The app's own delivery row. */
  app: AnyEntity;
  /** The asset the app is nested inside — what it edits. Null at top level. */
  subject: AnyEntity | null;
}

/**
 * Resolve `{app, subject}` for the page. Throws when the page was not served as
 * a webapp asset — a wrong answer here would silently edit the wrong entity.
 */
export async function resolveAppHost(): Promise<AppHost> {
  const typeId = appTypeId();
  if (!typeId) throw new Error('not served as a webapp asset');
  const app = await dataManager.getByTypeId(typeId);
  if (!app) throw new Error(`no ${typeId}`);
  const parent = (app as any).parent_type_id;
  const subject = parent ? await dataManager.getByTypeId(new TypeId(parent)) : null;
  return { app, subject };
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
  const prefersDark =
    typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = (param ? param === 'dark' : prefersDark) ? 'dark' : 'light';
  applyHostSkin(theme, appOption('view'), appOption('primary'), appOption('primaryInk'));
  // The URL carries the skin for the FIRST paint only — it is frozen there,
  // because the host addresses this frame by its src and re-addressing it would
  // reload the whole app to recolour it. Later changes arrive as a message, and
  // recolouring is a class flip.
  window.addEventListener('message', (event) => {
    const data = event.data as
      | { type?: string; theme?: string; view?: string; primary?: string; primaryInk?: string }
      | null;
    if (data?.type !== 'flowpad:theme') return;
    applyHostSkin(data.theme === 'dark' ? 'dark' : 'light', data.view ?? null, data.primary, data.primaryInk);
  });
  // Ask the host for the current skin. The host cannot know when this document
  // finished loading, and a message sent before this listener existed is gone —
  // so the guest starts the exchange rather than hoping it was heard.
  try {
    window.parent?.postMessage({ type: 'flowpad:skin-please' }, '*');
  } catch {
    // No parent, or a host that does not speak this protocol: the URL seed and
    // the OS preference already gave a correct-enough first paint.
  }
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
